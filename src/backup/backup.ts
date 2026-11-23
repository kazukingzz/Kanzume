import { randomBytes } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { gunzip as gunzipCb, gzip as gzipCb } from "node:zlib";
import { openedSiteDb } from "../bindings/db.ts";
import { SerialQueue } from "../serial.ts";
import { type Dek, decrypt, encrypt, KeyMismatchError, loadDek } from "./crypto.ts";
import { BackupStoreError, LocalStore, S3Store, type BackupStore } from "./store.ts";
import type { BackupConfig } from "./url.ts";
import { ADMIN_FILE, LOGS_DIR, META_DB, NOT_BACKED_UP, REPOS_DIR, SITE_DATA_DIR, SITES_DIR, UIDS_FILE } from "../layout.ts";
import { isInside } from "../paths.ts";
import { FIRST_UID } from "../runtime/process.ts";

const gzip = promisify(gzipCb);
const gunzip = promisify(gunzipCb);

/** バックアップしないもの（トップレベル）。復元とバックアップの作業ディレクトリも */
const SKIP_TOP = new Set([...NOT_BACKED_UP, ".restoring", ".backup-tmp"]);
/** Kanzume が管理する SQLite（VACUUM INTO で取る）。ほかの .sqlite（サイトのアセットなど）は普通のファイルとして扱う */
const MANAGED_DB = /^(meta\.sqlite|sites\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\/data\/data\.sqlite)$/;
/** 秘密を含むので、復元したときも本人だけが読めるようにするファイル */
const PRIVATE_FILE = /^(admin\.json|sites\/[^/]+\/settings\.json)$/;

/**
 * バックアップしないもの。Kanzume 自身が作る一時ファイルと、管理している SQLite の WAL などだけ
 * （ユーザーのファイルやブランチ名を、名前の末尾だけで落とさないようにする）
 */
function skipped(rel: string, isDir: boolean): boolean {
  if (isDir) return /^sites\/[^/]+\/releases\/[^/]+\.tmp$/.test(rel); // 作りかけのリリース
  const db = rel.replace(/-(wal|shm|journal)$/, "");
  if (db !== rel && MANAGED_DB.test(db)) return true;
  if (/^(admin\.json\.tmp|sites\/[^/]+\/(settings\.json\.tmp|current\.[^/]+\.tmp))$/.test(rel)) return true;
  // git が作業中に作るロック（ref の名前は .lock で終われないので、ユーザーのブランチとは重ならない）
  return /^repos\/[^/]+\.git\/.+\.lock$/.test(rel);
}
const DEBOUNCE_MS = 30_000;
const PARALLEL = 4;

/**
 * Worker の子プロセスが書けるところ（サイトの KV / R2）。中身も大きさも子が決められるので、1 つのファイルやサイトのせいで
 * 世代全体を作れなくならないように、大きさに上限を設け、読めないものは警告にしてほかのサイトのバックアップを続ける
 */
const CHILD_AREA = /^sites\/([^/]+)\/data\//;
const MAX_CHILD_FILE = 256 * 1024 * 1024;
const MAX_CHILD_SITE = 4 * 1024 * 1024 * 1024;
/** 同時に読み込んで圧縮・暗号化するファイルの大きさの合計。これより大きいファイルは 1 つずつ */
const MEMORY_BUDGET = 256 * 1024 * 1024;
const MAX_WARNINGS = 50;

/** 世代に入れてよいトップレベル（layout.ts）。バックアップもこれだけを取る */
const TOP_FILES = new Set([ADMIN_FILE, META_DB]);
const TOP_DIRS = new Set([LOGS_DIR, REPOS_DIR, SITES_DIR]);

/** バックアップに含めなかった（読めない・大きすぎる）ファイル。世代は作り、警告として残す */
class SkipFile extends Error {}

/** 読み込み中のファイルの大きさの合計を limit までにする（1 つで limit を超えるファイルは、ほかが終わってから 1 つだけ） */
class MemoryBudget {
  #used = 0;
  #waiting: (() => void)[] = [];
  readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  async acquire(bytes: number): Promise<() => void> {
    while (this.#used > 0 && this.#used + bytes > this.limit) await new Promise<void>((r) => this.#waiting.push(r));
    this.#used += bytes;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#used -= bytes;
      for (const wake of this.#waiting.splice(0)) wake();
    };
  }
}

/** 開いた fd の実際のパス（Linux）。読めない環境では null */
async function openedPath(fd: number): Promise<string | null> {
  return fs.readlink(`/proc/self/fd/${fd}`).catch(() => null);
}

/**
 * root の中の普通のファイルを、max バイトまで読む。シンボリックリンク・FIFO などは読まない
 * （子が data/ の中身を差し替えて、root の本体にほかの場所を読ませないため。途中のディレクトリの差し替えは、開いた fd の実際のパスで確かめる）
 */
async function readContained(abs: string, root: string, max: number): Promise<Buffer> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(abs, fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW | fsSync.constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "EMLINK") throw new SkipFile("シンボリックリンクです");
    throw err;
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new SkipFile("普通のファイルではありません");
    if (st.size > max) throw new SkipFile(`大きすぎます（${(st.size / 1024 / 1024).toFixed(1)} MiB。上限は ${max / 1024 / 1024} MiB）`);
    const real = (await openedPath(handle.fd)) ?? (await fs.realpath(abs));
    if (!isInside(root, real)) throw new SkipFile("データのディレクトリの外を指しています");
    // 読んでいる間に伸ばされても、開いたときの大きさまでしか読まない
    const buf = Buffer.allocUnsafe(st.size);
    let offset = 0;
    while (offset < st.size) {
      const { bytesRead } = await handle.read(buf, offset, st.size - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return buf.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

/** マニフェストのパスとして正しいか（相対・正規化済み・.. や絶対パスを含まない・決まったトップレベルの下） */
export function isSafeManifestPath(p: unknown, kind: "file" | "dir"): p is string {
  if (typeof p !== "string" || !p || p.length > 4096) return false;
  if (p.includes("\0") || p.includes("\\") || p.startsWith("/")) return false;
  const parts = p.split("/");
  if (parts.some((s) => s === "" || s === "." || s === "..")) return false;
  if (path.posix.normalize(p) !== p) return false;
  if (parts.length === 1) return kind === "file" ? TOP_FILES.has(p) : TOP_DIRS.has(p);
  return TOP_DIRS.has(parts[0]);
}

/**
 * 保存先から読んだマニフェストを確かめる。保存先に書ける人が世代を偽造しても、/data の外や決まった場所の外に書かせない
 * （1 つでもおかしければ、その世代は使わない）
 */
function checkManifest(name: string, raw: unknown): SnapshotManifest {
  const m = raw as SnapshotManifest;
  const broken = (why: string) => new UnsafeManifestError(`世代 ${name} のマニフェストが正しくないので復元しません（${why}）`);
  if (!m || typeof m !== "object" || m.version !== 1 || !Array.isArray(m.dirs) || !Array.isArray(m.files)) throw broken("形が違います");
  for (const d of m.dirs) if (!isSafeManifestPath(d, "dir")) throw broken(`ディレクトリ ${JSON.stringify(d).slice(0, 200)}`);
  for (const f of m.files) {
    if (!f || typeof f !== "object" || !isSafeManifestPath(f.path, "file")) throw broken(`ファイル ${JSON.stringify(f?.path).slice(0, 200)}`);
    if (typeof f.blob !== "string" || !/^[0-9a-f]{64}$/.test(f.blob)) throw broken(`${f.path} のデータの名前`);
  }
  return m;
}

/**
 * 復元しないリポジトリの中身。設定（core.fsmonitor・core.hooksPath・filter.*.smudge など）・フック・ほかの場所を指すファイル
 * （commondir・gitdir・alternates）は、push のデプロイで root の git に読ませるとコマンドを実行されうるので、
 * 偽造された世代から持ち込ませない。config は復元のあとに決まった内容で作り直す
 */
const REPO_KEEP = /^repos\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.git\/(HEAD|packed-refs|description|shallow|refs\/.+|logs\/.+|objects\/.+)$/;
/** 空でも要るディレクトリ（refs/ と objects/ がないと、git はリポジトリとして扱わない） */
const REPO_KEEP_DIR = /^repos\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.git\/(refs|objects|logs)(\/.+)?$/;
const REPO_DROP_OBJECTS = /^repos\/[^/]+\.git\/objects\/info\/(alternates|http-alternates)$/;
/** git init --bare で作る設定と同じもの */
const REPO_CONFIG = "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = true\n";

/** サイトの uid の割り当て。root（0）やシステムのユーザーで Worker を動かさせない */
function checkUids(name: string, data: Buffer): void {
  let map: unknown;
  try {
    map = JSON.parse(data.toString("utf8"));
  } catch {
    map = null;
  }
  const uids = map && typeof map === "object" && !Array.isArray(map) ? Object.values(map) : null;
  const ok = uids?.every((uid) => Number.isInteger(uid) && (uid as number) >= FIRST_UID && (uid as number) < 2 ** 31) && new Set(uids).size === uids.length;
  if (!ok) throw new UnsafeManifestError(`世代 ${name} の ${SITES_DIR}/${UIDS_FILE} が正しくないので復元しません`);
}

/** 復元してよいファイルか。リポジトリの中は、git の中身として要るものだけ */
function restorable(p: string): boolean {
  if (!p.startsWith(`${REPOS_DIR}/`)) return true;
  return REPO_KEEP.test(p) && !REPO_DROP_OBJECTS.test(p);
}

interface FileEntry {
  path: string;
  size: number;
  blob: string;
}

export interface SnapshotManifest {
  version: 1;
  createdAt: string;
  reason: string;
  dekId: string;
  dirs: string[];
  files: FileEntry[];
}

export interface BackupRun {
  at: string;
  ok: boolean;
  reason: string;
  /** 送らなかった理由（データが不完全・変更なし） */
  skipped?: string;
  error?: string;
  snapshot?: string;
  files?: number;
  uploadedFiles?: number;
  uploadedBytes?: number;
  /** 含めなかった・前の世代のものを使ったファイル（サイトの KV / R2 が読めない・大きすぎるなど） */
  warnings?: string[];
}

export interface RestoreRun {
  at: string;
  ok: boolean;
  snapshot?: string;
  files?: number;
  error?: string;
}

export function createBackupStore(config: BackupConfig): BackupStore {
  if (config.kind === "file") return new LocalStore(config.dir);
  return new S3Store(config);
}

/**
 * items を n 本ずつ並べて処理する。1 つでも失敗したら、残りは始めずに、動いているものが終わるのを待ってから失敗を投げる
 * （失敗のあとも書き込みが続いて、次の処理と混ざらないようにする）
 */
async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  let failed = false;
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (!failed && i < items.length) {
        try {
          await fn(items[i++]);
        } catch (err) {
          failed = true;
          throw err;
        }
      }
    }),
  );
  const rejected = results.find((r) => r.status === "rejected");
  if (rejected) throw (rejected as PromiseRejectedResult).reason;
}

/** ブロブがない・壊れている（この世代は使えない）。通信の失敗とは分けて、ひとつ前の世代を試す */
class SnapshotBroken extends Error {}

/**
 * マニフェストが /data の外や決まった場所の外を指している（保存先に書ける人が世代を偽造した疑い）。
 * 壊れた世代と違って前の世代に黙って戻らず、何も書かずに起動を止める
 */
export class UnsafeManifestError extends Error {}

/** 一時的な失敗（保存先との通信）なら数回やり直す */
async function retry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof BackupStoreError) || i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    }
  }
}

/** パスキーが登録されているか（初期セットアップが済んでいるか） */
async function hasCredentials(dataDir: string): Promise<boolean> {
  try {
    const admin = JSON.parse(await fs.readFile(path.join(dataDir, ADMIN_FILE), "utf8"));
    return Array.isArray(admin.credentials) && admin.credentials.length > 0;
  } catch {
    return false;
  }
}

async function hasEntries(dir: string, filter: (name: string) => boolean): Promise<boolean> {
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  return entries.some(filter);
}

/** /data が空か（セットアップ前で、サイトもリポジトリもない） */
export async function isDataEmpty(dataDir: string): Promise<boolean> {
  if (await hasCredentials(dataDir)) return false;
  if (await hasEntries(path.join(dataDir, SITES_DIR), (n) => /^[a-z0-9]/.test(n))) return false;
  if (await hasEntries(path.join(dataDir, REPOS_DIR), (n) => n.endsWith(".git"))) return false;
  return true;
}

const snapshotName = (d: Date) => d.toISOString().replace(/:/g, "-");

/**
 * /data を外部ストレージへバックアップし、空の /data に復元する。
 * - ファイルの中身は gzip して DEK で暗号化し、`blobs/<HMAC>` に置く（同じ中身は 1 回だけ送る）
 * - 世代は `snapshots/<日時>/manifest`（ファイルの一覧）。マニフェストを最後に書くので、マニフェストがある世代は完成している
 * - SQLite は `VACUUM INTO` で一貫したスナップショットを取ってから送る
 */
export class Backup {
  readonly config: BackupConfig;
  readonly dataDir: string;
  readonly store: BackupStore;
  lastBackup: BackupRun | null = null;
  lastRestore: RestoreRun | null = null;
  snapshotCount: number | null = null;
  latestSnapshot: string | null = null;

  #queue = new SerialQueue();
  #dek: Dek | null = null;
  #blobs: Set<string> | null = null;
  #manifests = new Map<string, SnapshotManifest>();
  /** パス → 前回読んだときの stat と blob 名（変わっていなければ読み直さない） */
  #cache = new Map<string, { sig: string; blob: string; size: number }>();
  #metaDb: DatabaseSync | null = null;
  #soon: NodeJS.Timeout | null = null;
  #interval: NodeJS.Timeout | null = null;

  constructor(config: BackupConfig, dataDir: string, store: BackupStore = createBackupStore(config)) {
    this.config = config;
    this.dataDir = dataDir;
    this.store = store;
  }

  /** ログに出す名前（認証情報を含まない） */
  get target(): string {
    return this.config.target;
  }

  /** 稼働中の meta.sqlite の接続（VACUUM INTO に使う） */
  attachMetaDb(db: DatabaseSync): void {
    this.#metaDb = db;
  }

  start(): void {
    this.stop();
    this.#interval = setInterval(() => void this.backupNow("定期").catch(() => {}), this.config.intervalMs);
    this.#interval.unref();
    void this.refresh().catch(() => {});
  }

  stop(): void {
    if (this.#interval) clearInterval(this.#interval);
    if (this.#soon) clearTimeout(this.#soon);
    this.#interval = this.#soon = null;
  }

  /** 変更があったときに呼ぶ。少し待ってまとめてバックアップする */
  requestSoon(): void {
    if (this.#soon) clearTimeout(this.#soon);
    this.#soon = setTimeout(() => {
      this.#soon = null;
      void this.backupNow("変更").catch(() => {});
    }, DEBOUNCE_MS);
    this.#soon.unref();
  }

  status() {
    return {
      enabled: true,
      target: this.target,
      keep: this.config.keep,
      intervalMinutes: Math.round(this.config.intervalMs / 60_000),
      snapshots: this.snapshotCount,
      latest: this.latestSnapshot,
      lastBackup: this.lastBackup,
      lastRestore: this.lastRestore,
    };
  }

  async snapshots(): Promise<string[]> {
    const keys = await this.store.list("snapshots/");
    return keys
      .filter((k) => k.endsWith("/manifest"))
      .map((k) => k.slice("snapshots/".length, -"/manifest".length))
      .sort();
  }

  /** 世代の数と最新の世代を読み直す（管理画面の表示用） */
  async refresh(): Promise<void> {
    const names = await this.snapshots();
    this.snapshotCount = names.length;
    this.latestSnapshot = names.at(-1) ?? null;
  }

  async #ensureDek(): Promise<Dek> {
    this.#dek ??= await loadDek(this.store, this.config.secret, this.config.previous);
    return this.#dek;
  }

  async #ensureBlobs(): Promise<Set<string>> {
    this.#blobs ??= new Set((await this.store.list("blobs/")).map((k) => k.slice("blobs/".length)));
    return this.#blobs;
  }

  async #readManifest(name: string): Promise<SnapshotManifest> {
    const cached = this.#manifests.get(name);
    if (cached) return cached;
    const dek = await this.#ensureDek();
    const data = await this.store.get(`snapshots/${name}/manifest`);
    if (!data) throw new Error(`世代 ${name} のマニフェストがありません`);
    const manifest = JSON.parse((await gunzip(decrypt(dek.key, data, `manifest:${name}`))).toString("utf8")) as SnapshotManifest;
    this.#manifests.set(name, manifest);
    return manifest;
  }

  // ---------- 復元 ----------

  /**
   * /data が空なら最新の世代を復元する（起動時、HTTP サーバーを始める前に呼ぶ）。
   * 世代がなければ何もしない。鍵が合わない・壊れているなどで復元できなければ例外
   */
  async restoreIfEmpty(): Promise<RestoreRun | null> {
    if (!(await isDataEmpty(this.dataDir))) {
      console.log(`[backup] /data にデータがあるので復元しません（保存先: ${this.target}）`);
      return null;
    }
    const names = await this.snapshots();
    if (!names.length) {
      console.log(`[backup] 保存先（${this.target}）にバックアップがないので、新しく始めます`);
      return null;
    }
    const at = new Date().toISOString();
    let lastError: unknown;
    // 最新の世代が壊れていたら、ひとつ前の世代を試す
    for (const name of names.slice(-3).reverse()) {
      try {
        const files = await this.#restore(name);
        this.lastRestore = { at, ok: true, snapshot: name, files };
        console.log(`[backup] ${this.target} の世代 ${name} を復元しました（${files} ファイル）`);
        return this.lastRestore;
      } catch (err) {
        // 通信の失敗などで古い世代に戻ると、新しい変更が黙って失われるので、壊れた世代のときだけ前の世代を試す
        if (!(err instanceof SnapshotBroken)) {
          this.lastRestore = { at, ok: false, error: (err as Error)?.message ?? String(err) };
          throw err;
        }
        lastError = err;
        console.error(`[backup] 世代 ${name} を復元できませんでした: ${(err as Error)?.message ?? err}`);
      }
    }
    this.lastRestore = { at, ok: false, error: (lastError as Error)?.message ?? String(lastError) };
    throw lastError;
  }

  async #restore(name: string): Promise<number> {
    const dek = await this.#ensureDek();
    let manifest: SnapshotManifest;
    try {
      manifest = await this.#readManifest(name);
    } catch (err) {
      if (err instanceof BackupStoreError) throw err;
      throw new SnapshotBroken(`世代 ${name} のマニフェストを読めません: ${(err as Error)?.message ?? err}`);
    }
    checkManifest(name, manifest);
    const staging = path.resolve(this.dataDir, ".restoring");
    const inStaging = (p: string) => {
      const dest = path.resolve(staging, p);
      // checkManifest で確かめてあるが、書く直前にも外に出ないことを確かめる
      if (!isInside(staging, dest) || dest === staging) throw new UnsafeManifestError(`世代 ${name} の ${p} は復元先の外を指しています`);
      return dest;
    };
    const files = manifest.files.filter((f) => restorable(f.path));
    const skipped = manifest.files.length - files.length;
    if (skipped) console.warn(`[backup] リポジトリの設定・フックなど ${skipped} ファイルは復元せず、作り直します`);
    await fs.rm(staging, { recursive: true, force: true });
    try {
      for (const d of manifest.dirs) {
        // フックのディレクトリなどは作らない（中身も復元しない）
        if (d.startsWith(`${REPOS_DIR}/`) && d.split("/").length > 2 && !REPO_KEEP_DIR.test(d)) continue;
        await fs.mkdir(inStaging(d), { recursive: true });
      }
      await pool(files, PARALLEL * 2, async (f) => {
        const data = await retry(() => this.store.get(`blobs/${f.blob}`));
        if (!data) throw new SnapshotBroken(`${f.path} のデータ（${f.blob.slice(0, 12)}）がありません`);
        let plain: Buffer;
        try {
          plain = await gunzip(decrypt(dek.key, data, `blob:${f.blob}`));
        } catch {
          throw new SnapshotBroken(`${f.path} のデータを復号できません`);
        }
        if (dek.blobName(plain) !== f.blob) throw new SnapshotBroken(`${f.path} のデータが壊れています`);
        if (f.path === `${SITES_DIR}/${UIDS_FILE}`) checkUids(name, plain);
        const dest = inStaging(f.path);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, plain, { mode: PRIVATE_FILE.test(f.path) ? 0o600 : 0o644 });
      });
      // リポジトリの設定は、偽造されていても使わないように決まった内容で作る
      for (const entry of await fs.readdir(path.join(staging, REPOS_DIR)).catch(() => [] as string[])) {
        const repo = path.join(staging, REPOS_DIR, entry);
        if (!entry.endsWith(".git") || !(await fs.lstat(repo)).isDirectory()) continue;
        await fs.writeFile(path.join(repo, "config"), REPO_CONFIG, { mode: 0o644 });
      }
      // 全部そろってから、トップレベルを入れ替える（起動前で、/data は空なので上書きしてよい）
      await fs.mkdir(this.dataDir, { recursive: true });
      for (const entry of await fs.readdir(staging)) {
        const dest = path.join(this.dataDir, entry);
        await fs.rm(dest, { recursive: true, force: true });
        if (entry.endsWith(".sqlite")) for (const s of ["-wal", "-shm"]) await fs.rm(dest + s, { force: true });
        await fs.rename(path.join(staging, entry), dest);
      }
      return files.length;
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
  }

  // ---------- バックアップ ----------

  /** 今のデータを 1 世代として送る。同時には 1 つしか動かない */
  backupNow(reason: string): Promise<BackupRun> {
    return this.#queue.run("backup", () => this.#backup(reason));
  }

  async #backup(reason: string): Promise<BackupRun> {
    const at = new Date().toISOString();
    const done = (run: Omit<BackupRun, "at" | "reason">) => {
      this.lastBackup = { at, reason, ...run };
      return this.lastBackup;
    };
    // 空や作りかけの /data を最新の世代にしない（復元前の空の状態で、正しいバックアップを押し流さないため）
    if (!(await hasCredentials(this.dataDir))) {
      console.log(`[backup] パスキーが登録されていない（データが空か不完全な）ので、バックアップをスキップしました`);
      return done({ ok: true, skipped: "データが空か不完全（パスキーが未登録）なのでスキップしました" });
    }
    try {
      const dek = await this.#ensureDek();
      const blobs = await this.#ensureBlobs();
      const tmpDir = path.join(this.dataDir, ".backup-tmp");
      await fs.rm(tmpDir, { recursive: true, force: true });
      await fs.mkdir(tmpDir, { recursive: true });
      const dirs: string[] = [];
      const files: FileEntry[] = [];
      let uploadedFiles = 0;
      let uploadedBytes = 0;
      const seen = new Set<string>();
      const warnings: string[] = [];
      const warn = (message: string) => {
        console.warn(`[backup] ${message}`);
        if (warnings.length < MAX_WARNINGS) warnings.push(message);
      };
      const budget = new MemoryBudget(MEMORY_BUDGET);
      const dataRoot = await fs.realpath(this.dataDir);
      const tmpRoot = await fs.realpath(tmpDir);
      /** サイトごとの、子が書けるところから読んだ大きさの合計 */
      const childBytes = new Map<string, number>();

      const inflight = new Map<string, Promise<void>>();
      /** estimate: 読む前に分かる大きさ（メモリの見積もり） */
      const upload = async (rel: string, sig: string, estimate: number, read: () => Promise<Buffer>) => {
        const cached = this.#cache.get(rel);
        if (cached && cached.sig === sig && blobs.has(cached.blob)) {
          files.push({ path: rel, size: cached.size, blob: cached.blob });
          return;
        }
        const release = await budget.acquire(estimate);
        try {
          const plain = await read();
          const blob = dek.blobName(plain);
          if (!blobs.has(blob)) {
            // 同じ中身のファイルが並んで処理されても、送るのは 1 回だけ
            let sending = inflight.get(blob);
            if (!sending) {
              sending = (async () => {
                const body = encrypt(dek.key, await gzip(plain), `blob:${blob}`);
                await this.store.put(`blobs/${blob}`, body);
                blobs.add(blob);
                uploadedFiles++;
                uploadedBytes += body.length;
              })().finally(() => inflight.delete(blob));
              inflight.set(blob, sending);
            }
            await sending;
          }
          this.#cache.set(rel, { sig, blob, size: plain.length });
          files.push({ path: rel, size: plain.length, blob });
        } finally {
          release();
        }
      };

      // 読めなかったサイトの DB は、前の世代のものを入れておく（消えたことにすると、復元したときに KV / R2 が空になる）
      let previous: SnapshotManifest | null | undefined;
      const keepPrevious = async (rel: string): Promise<boolean> => {
        const cached = this.#cache.get(rel);
        let entry: FileEntry | undefined = cached && { path: rel, size: cached.size, blob: cached.blob };
        if (!entry) {
          if (previous === undefined) {
            const latest = (await this.snapshots()).at(-1);
            previous = latest ? await this.#readManifest(latest).catch(() => null) : null;
          }
          entry = previous?.files.find((f) => f.path === rel);
        }
        if (!entry || !blobs.has(entry.blob)) return false;
        files.push({ ...entry });
        return true;
      };

      const statOf = (p: string) => fs.lstat(p).catch(() => null);
      const sigOf = (st: fsSync.Stats | null) => (st ? `${st.size}:${st.mtimeMs}` : "-");

      const snapshotDb = async (rel: string, abs: string) => {
        const st = await statOf(abs);
        // 子が DB をシンボリックリンクに差し替えても、ほかの DB を読まない
        if (st && !st.isFile()) throw new SkipFile("普通のファイルではありません");
        const sig = `${sigOf(st)}|${sigOf(await statOf(`${abs}-wal`))}`;
        const child = CHILD_AREA.test(rel);
        await upload(rel, sig, Math.min(st?.size ?? 0, MAX_CHILD_FILE), async () => {
          const tmp = path.join(tmpDir, `${randomBytes(6).toString("hex")}.sqlite`);
          const quoted = tmp.replace(/'/g, "''");
          // 動いている接続があればそれで取る。なければそのファイルだけを読み取り専用で開いて閉じる
          // （接続を開きっぱなしにせず、消されたサイトの DB を作り直さない）
          const live = rel === META_DB ? this.#metaDb : openedSiteDb(path.dirname(path.dirname(abs)));
          try {
            if (live) live.exec(`VACUUM INTO '${quoted}'`);
            else {
              const db = new DatabaseSync(abs, { readOnly: true });
              try {
                db.exec(`VACUUM INTO '${quoted}'`);
              } finally {
                db.close();
              }
            }
            return await readContained(tmp, tmpRoot, child ? MAX_CHILD_FILE : Number.MAX_SAFE_INTEGER);
          } finally {
            await fs.rm(tmp, { force: true });
          }
        });
      };

      const plainFile = async (r: string) => {
        const p = path.join(this.dataDir, r);
        const st = await statOf(p);
        if (!st) return; // 読む前に消えた
        const site = CHILD_AREA.exec(r)?.[1];
        if (site !== undefined) {
          const used = childBytes.get(site) ?? 0;
          if (st.size <= MAX_CHILD_FILE && used + st.size > MAX_CHILD_SITE) {
            throw new SkipFile(`サイト ${site} の KV / R2 の合計が上限（${MAX_CHILD_SITE / 1024 / 1024 / 1024} GiB）を超えます`);
          }
          if (st.size <= MAX_CHILD_FILE) childBytes.set(site, used + st.size);
        }
        const root = site !== undefined ? path.join(dataRoot, SITES_DIR, site, SITE_DATA_DIR) : dataRoot;
        const max = site !== undefined ? MAX_CHILD_FILE : Number.MAX_SAFE_INTEGER;
        await upload(r, sigOf(st), Math.min(st.size, MAX_CHILD_FILE), () => readContained(p, root, max));
      };

      /** 1 つのファイルを取る。子が書けるところや、読めずに飛ばしたファイルは警告にして続ける（世代全体を止めない） */
      const take = async (r: string, fn: () => Promise<void>) => {
        try {
          await fn();
        } catch (err) {
          // 読む前に消えた（サイトの削除と重なった）。SQLite は ENOENT ではなく開けないというエラーになる
          if ((err as NodeJS.ErrnoException).code === "ENOENT" || !(await statOf(path.join(this.dataDir, r)))) return;
          const child = CHILD_AREA.test(r);
          if (!child && !(err instanceof SkipFile)) throw err;
          const why = (err as Error)?.message ?? String(err);
          if (MANAGED_DB.test(r) && (await keepPrevious(r))) warn(`${r} を読めないので、前の世代のものを使います（${why}）`);
          else warn(`${r} を含めませんでした（${why}）`);
        }
      };

      const walk = async (rel: string) => {
        const abs = path.join(this.dataDir, rel);
        const entries = await fs.readdir(abs, { withFileTypes: true }).catch(() => []);
        // 管理している SQLite を先に取る（R2 のメタデータを先に固めてから、オブジェクトのファイルを読む）
        const managed = (name: string) => MANAGED_DB.test(rel ? `${rel}/${name}` : name);
        entries.sort((a, b) => Number(managed(b.name)) - Number(managed(a.name)) || a.name.localeCompare(b.name));
        const plain: string[] = [];
        for (const e of entries) {
          const r = rel ? `${rel}/${e.name}` : e.name;
          if (!rel && (SKIP_TOP.has(e.name) || !(e.isDirectory() ? TOP_DIRS : TOP_FILES).has(e.name))) continue;
          if (skipped(r, e.isDirectory())) continue;
          if (e.isDirectory()) {
            // 一覧を読んだあとにシンボリックリンクに差し替えられたディレクトリはたどらない
            if (!(await statOf(path.join(abs, e.name)))?.isDirectory()) continue;
            dirs.push(r);
            await walk(r);
          } else if (e.isFile()) {
            if (MANAGED_DB.test(r)) await take(r, () => snapshotDb(r, path.join(abs, e.name)));
            else plain.push(r);
          }
        }
        await pool(plain, PARALLEL, (r) => take(r, () => plainFile(r)));
      };
      try {
        await walk("");
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
      for (const f of files) seen.add(f.path);
      for (const p of this.#cache.keys()) if (!seen.has(p)) this.#cache.delete(p);
      files.sort((a, b) => a.path.localeCompare(b.path));
      dirs.sort();

      // 最新の世代と同じなら新しい世代を作らない
      const names = await this.snapshots();
      const latest = names.at(-1);
      if (latest) {
        const prev = await this.#readManifest(latest).catch(() => null);
        if (prev && JSON.stringify(prev.dirs) === JSON.stringify(dirs) && JSON.stringify(prev.files) === JSON.stringify(files)) {
          this.snapshotCount = names.length;
          this.latestSnapshot = latest;
          return done({
            ok: true,
            skipped: "前回から変更がありません",
            snapshot: latest,
            files: files.length,
            uploadedFiles,
            uploadedBytes,
            ...(warnings.length && { warnings }),
          });
        }
      }

      let name = snapshotName(new Date());
      if (latest && name <= latest) name = `${latest}-1`;
      const manifest: SnapshotManifest = { version: 1, createdAt: at, reason, dekId: dek.id, dirs, files };
      await this.store.put(`snapshots/${name}/manifest`, encrypt(dek.key, await gzip(JSON.stringify(manifest)), `manifest:${name}`));
      this.#manifests.set(name, manifest);
      names.push(name);
      await this.#prune(names);
      console.log(
        `[backup] ${this.target} に世代 ${name} を保存しました（${files.length} ファイル、送信 ${uploadedFiles} 件 ${(uploadedBytes / 1024).toFixed(1)} KiB）`,
      );
      return done({ ok: true, snapshot: name, files: files.length, uploadedFiles, uploadedBytes, ...(warnings.length && { warnings }) });
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      console.error(`[backup] ${this.target} へのバックアップに失敗しました: ${message}`);
      return done({ ok: false, error: message });
    }
  }

  /** 古い世代を消し、どの世代からも参照されないブロブを消す */
  async #prune(names: string[]): Promise<void> {
    const remove = names.slice(0, Math.max(0, names.length - this.config.keep));
    const keep = names.slice(remove.length);
    for (const name of remove) {
      await this.store.delete(`snapshots/${name}/manifest`);
      this.#manifests.delete(name);
    }
    this.snapshotCount = keep.length;
    this.latestSnapshot = keep.at(-1) ?? null;
    if (!remove.length) return;
    const used = new Set<string>();
    for (const name of keep) for (const f of (await this.#readManifest(name)).files) used.add(f.blob);
    const blobs = await this.#ensureBlobs();
    for (const blob of [...blobs]) {
      if (used.has(blob)) continue;
      await this.store.delete(`blobs/${blob}`);
      blobs.delete(blob);
    }
  }
}

/** 起動時の復元。ネットワークの失敗は数回やり直し、それでもだめなら例外（空のまま起動しないため） */
export async function restoreOnBoot(backup: Backup, attempts = 5, baseDelayMs = 2000): Promise<RestoreRun | null> {
  for (let i = 1; ; i++) {
    try {
      return await backup.restoreIfEmpty();
    } catch (err) {
      if (err instanceof KeyMismatchError || err instanceof UnsafeManifestError || i >= attempts) throw err;
      const wait = baseDelayMs * 2 ** (i - 1);
      console.error(`[backup] 復元に失敗しました（${i}/${attempts}）。${wait / 1000} 秒後にやり直します: ${(err as Error)?.message ?? err}`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}
