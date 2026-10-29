import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import { AssetsBinding } from "../bindings/assets.ts";
import { siteDb } from "../bindings/db.ts";
import { KVNamespace } from "../bindings/kv.ts";
import { R2Bucket } from "../bindings/r2.ts";
import { currentInvocation } from "../observability/events.ts";
import type { Release } from "../store.ts";
import { createGlobals, hasNodejsCompat } from "./globals.ts";

export class WorkerError extends Error {}

const NODE_MODULES = new Set([
  "assert",
  "assert/strict",
  "async_hooks",
  "buffer",
  "crypto",
  "diagnostics_channel",
  "events",
  "path",
  "path/posix",
  "punycode",
  "querystring",
  "stream",
  "stream/consumers",
  "stream/promises",
  "stream/web",
  "string_decoder",
  "timers",
  "timers/promises",
  "url",
  "util",
  "util/types",
  "zlib",
]);

const nodeRequire = createRequire(import.meta.url);

class WorkerEntrypoint {
  ctx: unknown;
  env: unknown;
  constructor(ctx: unknown, env: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}

class RpcTarget {}

class DurableObject {
  constructor() {
    throw new Error("Kanzume は Durable Objects に対応していません");
  }
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
  props: Record<string, unknown>;
}

export interface InvokeResult {
  response: Response | null;
  error: unknown;
  passThrough: boolean;
  waitUntil: Promise<unknown>[];
}

type Handler =
  | { kind: "object"; value: { fetch(request: Request, env: unknown, ctx: ExecutionContext): unknown } }
  | { kind: "class"; value: new (ctx: ExecutionContext, env: unknown) => { fetch(request: Request): unknown } };

const CALL = Symbol.for("kanzume.call");
const callScript = new vm.Script("globalThis[Symbol.for('kanzume.call')]()");

// 同期部分に CPU 時間の上限を掛けるため、Worker のコードは直接呼ばずに vm.Script 経由で呼ぶ
function runWithTimeout<T>(context: vm.Context, timeout: number, fn: () => T): T {
  const ctx = context as Record<PropertyKey, unknown>;
  ctx[CALL] = fn;
  try {
    return callScript.runInContext(context, { timeout }) as T;
  } finally {
    delete ctx[CALL];
  }
}

export class LoadedWorker {
  readonly release: Release;
  readonly context: vm.Context;
  #handler: Handler;
  #env: Record<string, unknown>;
  #timeout: number;

  constructor(release: Release, context: vm.Context, handler: Handler, env: Record<string, unknown>, timeout: number) {
    this.release = release;
    this.context = context;
    this.#handler = handler;
    this.#env = env;
    this.#timeout = timeout;
  }

  async fetch(request: Request): Promise<InvokeResult> {
    let passThrough = false;
    const name = this.release.manifest.name;
    const waitUntil: Promise<unknown>[] = [];
    const ctx: ExecutionContext = {
      waitUntil(promise) {
        waitUntil.push(
          Promise.resolve(promise).catch((err) => {
            console.error(`[${name}] waitUntil で例外:`, err);
            currentInvocation()?.exception(err);
          }),
        );
      },
      passThroughOnException() {
        passThrough = true;
      },
      props: {},
    };
    Object.defineProperty(request, "cf", { value: {}, enumerable: true });

    const handler = this.#handler;
    const env = this.#env;
    try {
      const result = await runWithTimeout(this.context, this.#timeout, () =>
        handler.kind === "class" ? new handler.value(ctx, env).fetch(request) : handler.value.fetch(request, env, ctx),
      );
      if (!(result instanceof Response)) throw new TypeError("fetch ハンドラは Response を返してください");
      return { response: result, error: null, passThrough, waitUntil };
    } catch (error) {
      return { response: null, error, passThrough, waitUntil };
    }
  }
}

function buildEnv(release: Release, siteDir: string): Record<string, unknown> {
  const { manifest } = release;
  const env: Record<string, unknown> = { ...manifest.vars };
  if (manifest.kvNamespaces.length || manifest.r2Buckets.length) {
    const db = siteDb(siteDir);
    for (const kv of manifest.kvNamespaces) env[kv.binding] = new KVNamespace(db, kv.binding);
    for (const r2 of manifest.r2Buckets) env[r2.binding] = new R2Bucket(db, siteDir, r2.bucketName);
  }
  if (manifest.assets?.binding) env[manifest.assets.binding] = new AssetsBinding(release);
  return env;
}

function message(err: unknown): string {
  return err && typeof (err as Error).message === "string" ? (err as Error).message : String(err);
}

/*
 * vm.SourceTextModule で ESM のまま読み込まないのは、Node 24 では SourceTextModule を作ったコンテキストが
 * GC されず、再デプロイや LRU で捨てた Worker のメモリが戻らないため。Action 側で CommonJS に変換したものを
 * vm.Script で読み込む。
 */
export async function loadWorker(release: Release, siteDir: string, timeout: number): Promise<LoadedWorker> {
  const { manifest } = release;
  if (!manifest.main) throw new WorkerError("Worker がありません");
  const workerDir = path.join(release.dir, "worker");
  const env = buildEnv(release, siteDir);
  const context = vm.createContext(createGlobals(manifest.name, manifest.compatibilityFlags, manifest.vars), {
    name: `kanzume:${manifest.name}`,
  });
  vm.runInContext("globalThis.self = globalThis", context);

  const nodeCompat = hasNodejsCompat(manifest.compatibilityFlags);
  const workersModule = { WorkerEntrypoint, RpcTarget, DurableObject, env };
  const cache = new Map<string, { exports: unknown }>();

  const loadFile = (file: string): unknown => {
    const cached = cache.get(file);
    if (cached) return cached.exports;
    const ext = path.extname(file);
    const module = { exports: {} as unknown };
    cache.set(file, module);
    if (ext === ".cjs" || ext === ".js") {
      const source = fs.readFileSync(file, "utf8");
      const script = new vm.Script(`(function (exports, require, module, __filename, __dirname) {${source}\n})`, {
        filename: path.relative(release.dir, file),
      });
      const fn = script.runInContext(context) as Function;
      const rel = `/${path.relative(workerDir, file)}`;
      fn.call(module.exports, module.exports, requireFrom(path.dirname(file)), module, rel, path.posix.dirname(rel));
      return module.exports;
    }
    const data = fs.readFileSync(file);
    if (ext === ".wasm") module.exports = new WebAssembly.Module(data);
    else if (ext === ".txt" || ext === ".html" || ext === ".sql") module.exports = data.toString("utf8");
    else if (ext === ".json") module.exports = JSON.parse(data.toString("utf8"));
    else module.exports = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    return module.exports;
  };

  const requireFrom = (dir: string) => (specifier: string) => {
    if (specifier === "cloudflare:workers") return workersModule;
    if (specifier.startsWith(".") || specifier.startsWith("/")) {
      const file = path.resolve(dir, specifier);
      if (!file.startsWith(workerDir + path.sep)) throw new WorkerError(`Worker の外のモジュールは読み込めません: ${specifier}`);
      if (!fs.existsSync(file)) throw new WorkerError(`モジュールが見つかりません: ${specifier}`);
      return loadFile(file);
    }
    const name = specifier.replace(/^node:/, "");
    if (!NODE_MODULES.has(name)) throw new WorkerError(`未対応のモジュールです: ${specifier}`);
    if (!nodeCompat) throw new WorkerError(`${specifier} を使うには compatibility_flags に nodejs_compat を指定してください`);
    return nodeRequire(`node:${name}`);
  };

  const entryPath = path.join(workerDir, manifest.main);
  if (!fs.existsSync(entryPath)) throw new WorkerError(`worker/${manifest.main} がありません`);
  try {
    const exports = runWithTimeout(context, timeout, () => loadFile(entryPath)) as Record<string, unknown>;
    const value = (exports?.default ?? exports) as { fetch?: unknown } | undefined;
    let handler: Handler;
    if (typeof value === "function" && typeof (value as { prototype?: { fetch?: unknown } }).prototype?.fetch === "function") {
      handler = { kind: "class", value: value as never };
    } else if (value && typeof value.fetch === "function") {
      handler = { kind: "object", value: value as never };
    } else {
      throw new WorkerError("export default に fetch ハンドラがありません（Service Worker 形式には対応していません）");
    }
    return new LoadedWorker(release, context, handler, env, timeout);
  } catch (err) {
    if (err instanceof WorkerError) throw err;
    throw new WorkerError(`worker/${manifest.main} の読み込みに失敗しました: ${message(err)}`);
  }
}
