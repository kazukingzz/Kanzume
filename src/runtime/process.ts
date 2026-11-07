/**
 * Worker をサイトごとの子プロセスで動かす（本体側）。
 * - 本体が root なら、子はサイトごとの別ユーザー（uid / gid）で動かす。サイトのディレクトリは root:<gid> の 2770 にして、
 *   ほかのサイトの子からは見えないようにする
 * - どの場合も Node の権限モデル（--permission）で、読み書きできる場所をサイトのディレクトリと Kanzume のソースだけにする
 */
import { fork, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { currentInvocation } from "../observability/events.ts";
import type { Release } from "../store.ts";
import { siteVars, WorkerError, type InvokeResult } from "./loader.ts";

const CHILD_SOURCE = new URL("./child.ts", import.meta.url).pathname;

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
const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection", "te", "trailer", "host"]);

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
 * 子がサイトのディレクトリだけを扱えるようにする。所有者は root、グループはサイトの gid、
 * ディレクトリは 2770（setgid でグループを引き継ぐ）、ファイルは 660。settings.json（シークレット）は root だけ
 */
function ensureSitePermissions(siteDir: string, gid: number): void {
  const walk = (p: string, top: boolean) => {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(p);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) return;
    if (top || path.basename(p) !== "settings.json" || path.dirname(p) !== siteDir) {
      if (st.gid !== gid) fs.chownSync(p, st.uid, gid);
    }
    if (st.isDirectory()) {
      if ((st.mode & 0o7777) !== 0o2770) fs.chmodSync(p, 0o2770);
      for (const name of fs.readdirSync(p)) walk(path.join(p, name), false);
    } else if (path.basename(p) === "settings.json" && path.dirname(p) === siteDir) {
      fs.chownSync(p, 0, 0);
      fs.chmodSync(p, 0o600);
    } else if ((st.mode & 0o060) !== 0o060) {
      fs.chmodSync(p, (st.mode & 0o7777) | 0o060);
    }
  };
  walk(siteDir, true);
}

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

const prepared = new Set<string>();

function looksPrepared(siteDir: string, gid: number): boolean {
  for (const p of [siteDir, path.join(siteDir, "data.sqlite")]) {
    try {
      const st = fs.statSync(p);
      if (st.gid !== gid) return false;
      if (st.isDirectory() ? (st.mode & 0o7777) !== 0o2770 : (st.mode & 0o060) !== 0o060) return false;
    } catch {}
  }
  return true;
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
  #pending = new Map<string, (done: Record<string, unknown> | null) => void>();
  #closed = false;
  #seq = 0;

  private constructor(release: Release, child: ChildProcess, socket: string, socketDir: string) {
    this.release = release;
    this.#child = child;
    this.#socket = socket;
    this.#socketDir = socketDir;
    child.on("message", (m: { type?: string; id?: string }) => {
      if (m?.type === "done" && m.id) {
        this.#pending.get(m.id)?.(m as Record<string, unknown>);
        this.#pending.delete(m.id);
      }
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

  get pid(): number | undefined {
    return this.#child.pid;
  }

  static async start(release: Release, options: ChildOptions): Promise<ChildWorker> {
    const siteDir = release.siteDir;
    const root = isRoot();
    const ids = root ? siteUid(options.dataDir, path.basename(siteDir)) : null;
    if (ids !== null) {
      ensureTraversable(options.dataDir, siteDir);
      // 1 プロセスで 1 サイト 1 回。ただし復元などでディレクトリが作り直されていたら（所有者やモードが違えば）直し直す
      if (!prepared.has(siteDir) || !looksPrepared(siteDir, ids)) {
        ensureSitePermissions(siteDir, ids);
        prepared.add(siteDir);
      }
    }
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
        `--allow-fs-write=${siteDir}`,
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
        child.on("message", (m: { type?: string; message?: string }) => {
          if (m?.type === "ready") {
            clearTimeout(timer);
            resolve();
          } else if (m?.type === "error") {
            clearTimeout(timer);
            reject(new WorkerError(m.message ?? "Worker を読み込めませんでした"));
          }
        });
        child.once("exit", (code, signal) => {
          clearTimeout(timer);
          reject(new WorkerError(`Worker のプロセスが終了しました（${signal ?? code}）`));
        });
        child.send({ type: "init", release, siteDir, timeout: options.timeout, vars: siteVars(release, siteDir), socket });
      });
    } catch (err) {
      worker.close();
      throw err;
    }
    return worker;
  }

  async fetch(request: Request): Promise<InvokeResult> {
    if (this.#closed) return { response: null, error: new Error("Worker のプロセスが終了しています"), passThrough: false, waitUntil: [] };
    const id = `${process.pid}-${++this.#seq}`;
    const invocation = currentInvocation();
    // 子のログと waitUntil が終わるのを待つ（本体は waitUntil が終わってから可観測性に記録する）
    const done = new Promise<void>((resolve) => {
      this.#pending.set(id, (d) => {
        if (d && invocation) {
          for (const log of (d.logs as typeof invocation.detail.logs) ?? []) invocation.detail.logs.push(log);
          invocation.detail.droppedLogs += Number(d.droppedLogs ?? 0);
          for (const e of (d.exceptions as typeof invocation.detail.exceptions) ?? []) invocation.detail.exceptions.push(e);
          for (const s of (d.subrequests as typeof invocation.detail.subrequests) ?? []) invocation.subrequest(s);
        }
        resolve();
      });
    });
    const headers: Record<string, string | string[]> = { "x-kanzume-id": id, "x-kanzume-url": request.url };
    for (const [k, v] of request.headers) if (!HOP_BY_HOP.has(k)) headers[k] = v;
    try {
      const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const req = http.request({ socketPath: this.#socket, method: request.method, path: "/", headers }, resolve);
        req.on("error", reject);
        if (request.body) Readable.fromWeb(request.body as never).on("error", (err) => req.destroy(err)).pipe(req);
        else req.end();
      });
      const failure = res.headers["x-kanzume-error"];
      if (failure) {
        res.resume();
        const info = JSON.parse(decodeURIComponent(String(failure))) as { message: string; name: string; stack?: string; passThrough: boolean };
        // 子のスタックトレース（Worker のコードの行）をそのまま使う
        const error = Object.assign(new Error(info.message), { name: info.name }, info.stack ? { stack: info.stack } : {});
        return { response: null, error, passThrough: info.passThrough, waitUntil: [done] };
      }
      const out = new Headers();
      for (let i = 0; i < res.rawHeaders.length; i += 2) {
        const name = res.rawHeaders[i].toLowerCase();
        if (!HOP_BY_HOP.has(name) && name !== "content-length") out.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
      }
      const nullBody = res.statusCode === 204 || res.statusCode === 304 || request.method === "HEAD";
      const body = nullBody ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>);
      if (nullBody) res.resume();
      return { response: new Response(body, { status: res.statusCode ?? 500, headers: out }), error: null, passThrough: false, waitUntil: [done] };
    } catch (err) {
      this.#pending.delete(id);
      return { response: null, error: new Error(`Worker のプロセスに届きませんでした: ${(err as Error)?.message ?? err}`), passThrough: false, waitUntil: [] };
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#child.kill("SIGKILL");
  }
}
