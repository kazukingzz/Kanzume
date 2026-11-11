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

const gzip = promisify(gzipCb);
const gunzip = promisify(gunzipCb);

/** バックアップしないもの（トップレベル） */
const SKIP_TOP = new Set(["git-hooks", ".restoring", ".backup-tmp"]);
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
    const admin = JSON.parse(await fs.readFile(path.join(dataDir, "admin.json"), "utf8"));
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
  if (await hasEntries(path.join(dataDir, "sites"), (n) => /^[a-z0-9]/.test(n))) return false;
  if (await hasEntries(path.join(dataDir, "repos"), (n) => n.endsWith(".git"))) return false;
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
    const staging = path.join(this.dataDir, ".restoring");
    await fs.rm(staging, { recursive: true, force: true });
    try {
      for (const d of manifest.dirs) await fs.mkdir(path.join(staging, d), { recursive: true });
      await pool(manifest.files, PARALLEL * 2, async (f) => {
        const data = await retry(() => this.store.get(`blobs/${f.blob}`));
        if (!data) throw new SnapshotBroken(`${f.path} のデータ（${f.blob.slice(0, 12)}）がありません`);
        let plain: Buffer;
        try {
          plain = await gunzip(decrypt(dek.key, data, `blob:${f.blob}`));
        } catch {
          throw new SnapshotBroken(`${f.path} のデータを復号できません`);
        }
        if (dek.blobName(plain) !== f.blob) throw new SnapshotBroken(`${f.path} のデータが壊れています`);
        const dest = path.join(staging, f.path);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, plain, { mode: PRIVATE_FILE.test(f.path) ? 0o600 : 0o644 });
      });
      // 全部そろってから、トップレベルを入れ替える（起動前で、/data は空なので上書きしてよい）
      await fs.mkdir(this.dataDir, { recursive: true });
      for (const entry of await fs.readdir(staging)) {
        const dest = path.join(this.dataDir, entry);
        await fs.rm(dest, { recursive: true, force: true });
        if (entry.endsWith(".sqlite")) for (const s of ["-wal", "-shm"]) await fs.rm(dest + s, { force: true });
        await fs.rename(path.join(staging, entry), dest);
      }
      return manifest.files.length;
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

      const inflight = new Map<string, Promise<void>>();
      const upload = async (rel: string, sig: string, read: () => Promise<Buffer>) => {
        const cached = this.#cache.get(rel);
        if (cached && cached.sig === sig && blobs.has(cached.blob)) {
          files.push({ path: rel, size: cached.size, blob: cached.blob });
          return;
        }
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
      };

      const statSig = async (p: string) => {
        const st = await fs.stat(p).catch(() => null);
        return st ? `${st.size}:${st.mtimeMs}` : "-";
      };

      const snapshotDb = async (rel: string, abs: string) => {
        const sig = `${await statSig(abs)}|${await statSig(`${abs}-wal`)}`;
        await upload(rel, sig, async () => {
          const tmp = path.join(tmpDir, `${randomBytes(6).toString("hex")}.sqlite`);
          const quoted = tmp.replace(/'/g, "''");
          // 動いている接続があればそれで取る。なければそのファイルだけを読み取り専用で開いて閉じる
          // （接続を開きっぱなしにせず、消されたサイトの DB を作り直さない）
          const live = rel === "meta.sqlite" ? this.#metaDb : openedSiteDb(path.dirname(path.dirname(abs)));
          if (live) live.exec(`VACUUM INTO '${quoted}'`);
          else {
            const db = new DatabaseSync(abs, { readOnly: true });
            try {
              db.exec(`VACUUM INTO '${quoted}'`);
            } finally {
              db.close();
            }
          }
          try {
            return await fs.readFile(tmp);
          } finally {
            await fs.rm(tmp, { force: true });
          }
        });
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
          if (!rel && SKIP_TOP.has(e.name)) continue;
          if (skipped(r, e.isDirectory())) continue;
          if (e.isDirectory()) {
            dirs.push(r);
            await walk(r);
          } else if (e.isFile()) {
            if (MANAGED_DB.test(r)) {
              try {
                await snapshotDb(r, path.join(abs, e.name));
              } catch (err) {
                // 読む前に消えた（サイトの削除と重なった）
                if (fsSync.existsSync(path.join(abs, e.name))) throw err;
              }
            } else plain.push(r);
          }
        }
        await pool(plain, PARALLEL, async (r) => {
          const p = path.join(this.dataDir, r);
          const sig = await statSig(p);
          if (sig === "-") return; // 読む前に消えた
          try {
            await upload(r, sig, () => fs.readFile(p));
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
          }
        });
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
        // ログ（meta.sqlite）はリクエストのたびに変わるので、定期実行のときだけ変更として数える。
        // ほかのきっかけ（デプロイ・設定の変更）では、ログだけの違いで世代を増やさない
        const key = (fs: FileEntry[]) => JSON.stringify(reason === "定期" ? fs : fs.filter((f) => f.path !== "meta.sqlite"));
        if (prev && JSON.stringify(prev.dirs) === JSON.stringify(dirs) && key(prev.files) === key(files)) {
          this.snapshotCount = names.length;
          this.latestSnapshot = latest;
          return done({ ok: true, skipped: "前回から変更がありません", snapshot: latest, files: files.length, uploadedFiles, uploadedBytes });
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
      return done({ ok: true, snapshot: name, files: files.length, uploadedFiles, uploadedBytes });
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
      if (err instanceof KeyMismatchError || i >= attempts) throw err;
      const wait = baseDelayMs * 2 ** (i - 1);
      console.error(`[backup] 復元に失敗しました（${i}/${attempts}）。${wait / 1000} 秒後にやり直します: ${(err as Error)?.message ?? err}`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}
