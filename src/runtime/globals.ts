import { Buffer } from "node:buffer";
import { currentInvocation, type LogLevel } from "../observability/events.ts";

const SHARED_GLOBALS = [
  "Request",
  "Response",
  "Headers",
  "fetch",
  "FormData",
  "Blob",
  "File",
  "URL",
  "URLSearchParams",
  "URLPattern",
  "TextEncoder",
  "TextDecoder",
  "TextEncoderStream",
  "TextDecoderStream",
  "ReadableStream",
  "ReadableStreamDefaultReader",
  "ReadableStreamBYOBReader",
  "ReadableByteStreamController",
  "WritableStream",
  "WritableStreamDefaultWriter",
  "TransformStream",
  "CompressionStream",
  "DecompressionStream",
  "ByteLengthQueuingStrategy",
  "CountQueuingStrategy",
  "crypto",
  "Crypto",
  "CryptoKey",
  "SubtleCrypto",
  "AbortController",
  "AbortSignal",
  "Event",
  "EventTarget",
  "CustomEvent",
  "MessageChannel",
  "MessagePort",
  "MessageEvent",
  "DOMException",
  "WebSocket",
  "performance",
  "atob",
  "btoa",
  "structuredClone",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "queueMicrotask",
  // Node の API が返す ArrayBuffer / TypedArray は外側の realm のものなので、
  // Worker 側の instanceof が通るように同じコンストラクタを見せる
  "ArrayBuffer",
  "DataView",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
  "WebAssembly",
] as const;

function workerConsole(name: string): Console {
  const tag = `[${name}]`;
  const wrap =
    (level: LogLevel, fn: (...args: unknown[]) => void) =>
    (...args: unknown[]) => {
      const invocation = currentInvocation();
      if (invocation?.worker === name) invocation.log(level, args);
      fn(tag, ...args);
    };
  return {
    ...console,
    log: wrap("log", console.log),
    info: wrap("info", console.info),
    warn: wrap("warn", console.warn),
    error: wrap("error", console.error),
    debug: wrap("debug", console.debug),
    trace: wrap("debug", console.trace),
  };
}

function trackedFetch(name: string): typeof fetch {
  return (input, init) => {
    const invocation = currentInvocation();
    const promise = fetch(input, init);
    if (invocation?.worker !== name) return promise;
    const ts = Date.now();
    const started = performance.now();
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const url = input instanceof Request ? input.url : String(input);
    const done = (status: number | null, error: string | null) =>
      invocation.subrequest({ ts, method, url: url.slice(0, 1024), status, durationMs: Math.round(performance.now() - started), error });
    promise.then(
      (r) => done(r.status, null),
      (e) => done(null, String((e as Error)?.message ?? e)),
    );
    return promise;
  };
}

const noopCache = {
  match: async () => undefined,
  put: async () => undefined,
  delete: async () => false,
};

export function hasNodejsCompat(flags: string[]): boolean {
  return flags.some((f) => f === "nodejs_compat" || f === "nodejs_compat_v2");
}

export function createGlobals(name: string, flags: string[], vars: Record<string, unknown>): Record<string, unknown> {
  const g: Record<string, unknown> = {};
  for (const key of SHARED_GLOBALS) {
    const value = (globalThis as Record<string, unknown>)[key];
    if (value !== undefined) g[key] = value;
  }
  g.console = workerConsole(name);
  g.fetch = trackedFetch(name);
  g.navigator = { userAgent: "Cloudflare-Workers", language: "en" };
  g.caches = { default: noopCache, open: async () => noopCache };

  if (hasNodejsCompat(flags)) {
    g.Buffer = Buffer;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(vars)) env[k] = typeof v === "string" ? v : JSON.stringify(v);
    g.process = {
      env,
      version: process.version,
      versions: { node: process.versions.node },
      platform: "linux",
      arch: "x64",
      argv: [],
      cwd: () => "/",
      nextTick: process.nextTick,
      hrtime: process.hrtime,
      emitWarning: () => {},
    };
  }
  return g;
}
