/**
 * Worker をサイトごとの子プロセスで動かす（本体側）。
 * - 本体が root なら、子はサイトごとの別ユーザー（uid / gid）で動かす。サイトのディレクトリは root:<gid> の 2770 にして、
 *   ほかのサイトの子からは見えないようにする
 * - どの場合も Node の権限モデル（--permission）で、読み書きできる場所をサイトのディレクトリと Kanzume のソースだけにする
 */
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { siteDataDir } from "../bindings/db.ts";
import { currentInvocation } from "../observability/events.ts";
import { SETTINGS_FILE } from "../sites.ts";
import type { Release } from "../store.ts";
import { siteVars, WorkerError, type InvokeResult } from "./loader.ts";

const CHILD_SOURCE = fileURLToPath(new URL("./child.ts", import.meta.url));

/**
 * child.ts と、それが import するものを 1 つの JS にまとめる（本体の起動ごとに 1 回）。
 * TypeScript のまま子で読み込むと、型の除去と多数のモジュールで子 1 つあたり約 30 MiB 多くメモリを使うため。
 * 子が読めるのはこのディレクトリだけで、リポジトリのほかの場所（開発用の .data など）は読ませない
 */
let bundled: Promise<string> | null = null;
function childEntry(): Promise<string> {
  bundled ??= (async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kanzume-child-"));
    fs.chmodSync(dir, 0o755);
    const out = path.join(dir, "child.mjs");
    const { build } = await import("esbuild");
    await build({ entryPoints: [CHILD_SOURCE], outfile: out, bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent" });
    fs.chmodSync(out, 0o644);
    process.once("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
    return out;
  })();
  bundled.catch(() => (bundled = null));
  return bundled;
}
const START_TIMEOUT_MS = 30_000;
const FIRST_UID = 20000;
/** 子に転送しないリクエストヘッダー。content-length は本文の送り方を Node に任せるため（GET の本文は送らないので食い違う） */
const REQUEST_SKIP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection", "te", "trailer", "content-length"]);
/** 子からの応答で引き継がないヘッダー */
const RESPONSE_SKIP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection", "te", "trailer"]);
/** 再デプロイや追い出しで外した子が、処理中のリクエストと waitUntil を終えるのを待つ上限 */
const RETIRE_DEADLINE_MS = 35_000;
/** 子が返す Worker の例外（JSON）の上限 */
const MAX_ERROR_BYTES = 256 * 1024;

export const isRoot = () => typeof process.getuid === "function" && process.getuid() === 0;

/** サイトごとの uid / gid（20000 から順に割り当て、<data>/sites/_uids.json に保存する） */
export function siteUid(dataDir: string, site: string): number {
  const file = path.join(dataDir, "sites", "_uids.json");
  let map: Record<string, number> = {};
  try {
    map = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {}
  if (typeof map[site] === "number") return map[site];
  const used = new Set(Object.values(map));
  let uid = FIRST_UID;
  while (used.has(uid)) uid++;
  map[site] = uid;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(map), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
  return uid;
}

/**
 * サイトのディレクトリの権限。子（サイトの gid）は次のとおりにしか触れない:
 * - サイトのディレクトリとリリース: root:<gid>、ディレクトリ 2750・ファイル 0640（読むだけ。消す・置き換えることもできない）
 * - settings.json（シークレット）: root:root の 0600（読めない）
 * - data/（KV / R2）: root:<gid> の 2770（ここだけ書ける。setgid で中のファイルもサイトの gid になる）
 */
const OPEN_DIR = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
const OPEN_FILE = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;

/**
 * 1 つのファイル・ディレクトリの所有者とモードをそろえる。シンボリックリンクはたどらない
 * （子が data/ に置いたリンクで、root の本体にほかの場所を書き換えさせないため。開いた fd に対して変える）
 */
function fixEntry(p: string, isDir: boolean, owner: number | null, gid: number, mode: (current: number) => number): void {
  let fd: number;
  try {
    fd = fs.openSync(p, isDir ? OPEN_DIR : OPEN_FILE);
  } catch {
    return;
  }
  try {
    const st = fs.fstatSync(fd);
    if (st.isDirectory() !== isDir || (!isDir && !st.isFile())) return;
    const uid = owner ?? st.uid;
    if (st.uid !== uid || st.gid !== gid) fs.fchownSync(fd, uid, gid);
    const next = mode(st.mode & 0o7777);
    if ((st.mode & 0o7777) !== next) fs.fchmodSync(fd, next);
  } finally {
    fs.closeSync(fd);
  }
}

const readOnly = (isDir: boolean) => () => (isDir ? 0o2750 : 0o640);
const writable = (isDir: boolean) => (m: number) => (isDir ? 0o2770 : (m & 0o770) | 0o660);

/**
 * サイトのディレクトリ全体をそろえる。本体の起動時（子がまだ動いていないとき）に、全サイトに対して呼ぶ。
 * 以前のバージョンのデータや、バックアップから戻したデータもここで直る
 */
export function prepareSiteDir(siteDir: string, gid: number): void {
  const data = siteDataDir(siteDir);
  fs.mkdirSync(data, { recursive: true });
  const walk = (p: string) => {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(p);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) return;
    const isDir = st.isDirectory();
    if (p === path.join(siteDir, SETTINGS_FILE)) return fixEntry(p, false, 0, 0, () => 0o600);
    const inData = p === data || p.startsWith(data + path.sep);
    fixEntry(p, isDir, inData ? null : 0, gid, inData ? writable(isDir) : readOnly(isDir));
    if (isDir) for (const name of fs.readdirSync(p)) walk(path.join(p, name));
  };
  walk(siteDir);
  fixEntry(data, true, 0, gid, writable(true));
}

/** 子を起動する前に、そのサイトで本体が作ったばかりのもの（リリース・data/・設定）をそろえる */
function prepareForChild(siteDir: string, releaseDir: string, gid: number): void {
  fixEntry(siteDir, true, 0, gid, readOnly(true));
  const data = siteDataDir(siteDir);
  fs.mkdirSync(data, { recursive: true });
  fixEntry(data, true, 0, gid, writable(true));
  for (const name of ["data.sqlite", "data.sqlite-wal", "data.sqlite-shm"]) fixEntry(path.join(data, name), false, null, gid, writable(false));
  fixEntry(path.join(siteDir, SETTINGS_FILE), false, 0, 0, () => 0o600);
  fixEntry(path.join(siteDir, "current"), false, 0, gid, readOnly(false));
  fixEntry(path.join(siteDir, "releases"), true, 0, gid, readOnly(true));
  // リリースは作ったあと変わらないので、1 つにつき 1 回
  if (preparedReleases.has(releaseDir)) return;
  const walk = (p: string, isDir: boolean) => {
    fixEntry(p, isDir, 0, gid, readOnly(isDir));
    if (isDir) for (const e of fs.readdirSync(p, { withFileTypes: true })) if (!e.isSymbolicLink()) walk(path.join(p, e.name), e.isDirectory());
  };
  walk(releaseDir, true);
  preparedReleases.add(releaseDir);
}

const preparedReleases = new Set<string>();

/** 子がサイトのディレクトリまでたどれるように、データのディレクトリからの途中を 0711 にする（中身の一覧は見せない） */
function ensureTraversable(dataDir: string, siteDir: string): void {
  let dir = path.dirname(siteDir);
  const root = path.resolve(dataDir);
  while (dir.startsWith(root)) {
    const st = fs.statSync(dir);
    if ((st.mode & 0o001) === 0) fs.chmodSync(dir, (st.mode & 0o7777) | 0o011);
    if (dir === root) break;
    dir = path.dirname(dir);
  }
}

export interface ChildOptions {
  dataDir: string;
  timeout: number;
  /** 子の V8 のヒープの上限（MB） */
  heapMb?: number;
}

/** 子プロセスで動いている Worker。LoadedWorker と同じく fetch で呼べる */
export class ChildWorker {
  readonly release: Release;
  #child: ChildProcess;
  #socket: string;
  #socketDir: string;
  #pending = new Map<string, (done: unknown) => void>();
  #closed = false;
  #retiring = false;

  private constructor(release: Release, child: ChildProcess, socket: string, socketDir: string) {
    this.release = release;
    this.#child = child;
    this.#socket = socket;
    this.#socketDir = socketDir;
    // 子は信頼できない（Worker が vm から抜け出せる）。メッセージの形を確かめ、知らない id は捨てる
    child.on("message", (m: unknown) => {
      if (!m || typeof m !== "object") return;
      const { type, id } = m as { type?: unknown; id?: unknown };
      if (type !== "done" || typeof id !== "string") return;
      const resolve = this.#pending.get(id);
      if (!resolve) return;
      this.#pending.delete(id);
      resolve(m);
      this.#maybeFinishRetire();
    });
    // fork の失敗（EACCES / EAGAIN など）や IPC の書き込みエラー。リスナーがないと本体ごと落ちる
    child.on("error", (err) => {
      console.error(`[runtime] Worker のプロセスでエラー（${release.manifest.name}）:`, err.message);
      this.#kill();
    });
    child.on("exit", () => {
      this.#closed = true;
      for (const resolve of this.#pending.values()) resolve(null);
      this.#pending.clear();
      fs.rmSync(this.#socketDir, { recursive: true, force: true });
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  get busy(): boolean {
    return this.#pending.size > 0;
  }

  get pid(): number | undefined {
    return this.#child.pid;
  }

  static async start(release: Release, options: ChildOptions): Promise<ChildWorker> {
    const siteDir = release.siteDir;
    const root = isRoot();
    const ids = root ? siteUid(options.dataDir, path.basename(siteDir)) : null;
    if (ids !== null) {
      ensureTraversable(options.dataDir, siteDir);
      prepareForChild(siteDir, release.dir, ids);
    }
    fs.mkdirSync(siteDataDir(siteDir), { recursive: true });
    const entry = await childEntry();
    const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), "kanzume-"));
    if (ids !== null) fs.chownSync(socketDir, ids, ids);
    const socket = path.join(socketDir, "worker.sock");
    const child = fork(entry, [], {
      ...(ids !== null ? { uid: ids, gid: ids } : {}),
      // 本体の環境変数（KANZUME_BACKUP_URL など）は渡さない
      env: { PATH: process.env.PATH ?? "", TZ: process.env.TZ ?? "", NODE_ENV: process.env.NODE_ENV ?? "" },
      execArgv: [
        "--disable-warning=ExperimentalWarning",
        "--permission",
        `--allow-fs-read=${path.dirname(entry)}`,
        `--allow-fs-read=${siteDir}`,
        `--allow-fs-read=${socketDir}`,
        // 書けるのは KV / R2 の置き場所だけ（settings.json やリリースは書き換えさせない）
        `--allow-fs-write=${siteDataDir(siteDir)}`,
        `--allow-fs-write=${socketDir}`,
        `--max-old-space-size=${options.heapMb ?? 64}`,
      ],
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      serialization: "advanced",
    });
    const worker = new ChildWorker(release, child, socket, socketDir);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new WorkerError("Worker のプロセスが起動しませんでした（時間切れ）")), START_TIMEOUT_MS);
        child.on("message", (m: { type?: unknown; message?: unknown }) => {
          if (m?.type === "ready") {
            clearTimeout(timer);
            resolve();
          } else if (m?.type === "error") {
            clearTimeout(timer);
            reject(new WorkerError(typeof m.message === "string" ? m.message.slice(0, 4096) : "Worker を読み込めませんでした"));
          }
        });
        child.once("error", (err) => {
          clearTimeout(timer);
          reject(new WorkerError(`Worker のプロセスを起動できませんでした: ${err.message}`));
        });
        child.once("exit", (code, signal) => {
          clearTimeout(timer);
          reject(new WorkerError(`Worker のプロセスが終了しました（${signal ?? code}）`));
        });
        child.send({ type: "init", release, siteDir, timeout: options.timeout, vars: siteVars(release, siteDir), socket }, (err) => {
          if (err) {
            clearTimeout(timer);
            reject(new WorkerError(`Worker のプロセスに設定を渡せませんでした: ${err.message}`));
          }
        });
      });
    } catch (err) {
      worker.close();
      throw err;
    }
    return worker;
  }

  async fetch(request: Request): Promise<InvokeResult> {
    if (this.#closed) return { response: null, error: new Error("Worker のプロセスが終了しています"), passThrough: false, waitUntil: [] };
    // 推測できない ID にする（ほかのリクエストのログに紛れ込ませないため）
    const id = randomUUID();
    const invocation = currentInvocation();
    // 子のログ・応答の送信・waitUntil が終わるのを待つ（本体は終わってから可観測性に記録する）
    const done = new Promise<void>((resolve) => {
      this.#pending.set(id, (d) => {
        if (d && invocation) invocation.merge(d);
        resolve();
      });
    });
    // クライアントのヘッダーを先に入れ、内部用の x-kanzume-* は落としてから本体の値で上書きする（訪問者に偽らせない）
    const headers: Record<string, string> = {};
    for (const [k, v] of request.headers) if (!REQUEST_SKIP.has(k) && !k.startsWith("x-kanzume-")) headers[k] = v;
    headers["x-kanzume-id"] = id;
    headers["x-kanzume-url"] = request.url;
    // DELETE などでも本文を正しく区切って送る
    if (request.body) headers["transfer-encoding"] = "chunked";
    try {
      const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const req = http.request({ socketPath: this.#socket, method: request.method, path: "/", headers, maxHeaderSize: 256 * 1024 }, resolve);
        req.on("error", reject);
        if (request.body) Readable.fromWeb(request.body as never).on("error", (err) => req.destroy(err)).pipe(req);
        else req.end();
      });
      if (res.headers["x-kanzume-error"]) {
        const info = await readError(res);
        // 子のスタックトレース（Worker のコードの行）をそのまま使う
        const error = Object.assign(new Error(info.message), { name: info.name }, info.stack ? { stack: info.stack } : {});
        return { response: null, error, passThrough: info.passThrough, waitUntil: [done] };
      }
      const out = new Headers();
      for (let i = 0; i < res.rawHeaders.length; i += 2) {
        if (!RESPONSE_SKIP.has(res.rawHeaders[i].toLowerCase())) out.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
      }
      const status = res.statusCode ?? 500;
      const nullBody = status === 204 || status === 205 || status === 304 || request.method === "HEAD";
      const body = nullBody ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>);
      if (nullBody) res.resume();
      return { response: new Response(body, { status, statusText: res.statusMessage, headers: out }), error: null, passThrough: false, waitUntil: [done] };
    } catch (err) {
      this.#pending.get(id)?.(null);
      this.#pending.delete(id);
      this.#maybeFinishRetire();
      return { response: null, error: new Error(`Worker のプロセスに届きませんでした: ${(err as Error)?.message ?? err}`), passThrough: false, waitUntil: [] };
    }
  }

  /**
   * 使わなくなった子を止める。処理中のリクエスト（応答の送信と waitUntil を含む）が終わるのを待ち、
   * 終わらなければ期限で止める（再デプロイや追い出しで、処理中のリクエストを切らないため）
   */
  retire(): void {
    if (this.#closed || this.#retiring) return;
    this.#retiring = true;
    setTimeout(() => this.#kill(), RETIRE_DEADLINE_MS).unref();
    this.#maybeFinishRetire();
  }

  #maybeFinishRetire(): void {
    if (this.#retiring && this.#pending.size === 0) this.#kill();
  }

  /** すぐに止める（本体の終了や起動の失敗のとき） */
  close(): void {
    this.#kill();
  }

  #kill(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#child.kill("SIGKILL");
  }
}

/** 子が返した Worker の例外（本文の JSON）を読む。大きすぎるものや壊れたものは丸める */
async function readError(res: http.IncomingMessage): Promise<{ message: string; name: string; stack?: string; passThrough: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res) {
    size += (chunk as Buffer).length;
    if (size > MAX_ERROR_BYTES) {
      res.destroy();
      break;
    }
    chunks.push(chunk as Buffer);
  }
  try {
    const info = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    return {
      message: typeof info.message === "string" ? info.message : "Worker threw exception",
      name: typeof info.name === "string" ? info.name : "Error",
      stack: typeof info.stack === "string" ? info.stack : undefined,
      passThrough: info.passThrough === true,
    };
  } catch {
    return { message: "Worker threw exception", name: "Error", passThrough: false };
  }
}
