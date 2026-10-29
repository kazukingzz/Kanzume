import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { test } from "node:test";
import { closeSiteDb } from "../src/bindings/db.ts";
import { loadWorker, WorkerError } from "../src/runtime/loader.ts";
import { Runtime } from "../src/runtime/runtime.ts";
import type { Manifest } from "../src/store.ts";
import { manifest, release, toCjs } from "./helpers.ts";

async function worker(t: Parameters<typeof release>[0], source: string | Record<string, string>, m: Partial<Manifest> = {}) {
  const raw = typeof source === "string" ? { "worker/index.js": source } : source;
  const files = "worker/index.cjs" in raw ? raw : toCjs(t, raw);
  const { release: r, store } = await release(t, manifest(m), files);
  t.after(() => closeSiteDb(store.siteDir));
  return { r, store, load: () => loadWorker(r, store.siteDir, 200) };
}

test("ES Modules 形式の fetch ハンドラに request / env / ctx が渡る", async (t) => {
  const { load } = await worker(
    t,
    `export default {
      async fetch(request, env, ctx) {
        ctx.waitUntil(Promise.resolve());
        return Response.json({ url: request.url, greeting: env.GREETING, self: typeof self, ua: navigator.userAgent });
      }
    }`,
    { vars: { GREETING: "hi" } },
  );
  const w = await load();
  const { response } = await w.fetch(new Request("http://x/path?q=1"));
  assert.deepEqual(await response!.json(), { url: "http://x/path?q=1", greeting: "hi", self: "object", ua: "Cloudflare-Workers" });
});

test("cloudflare:workers の WorkerEntrypoint クラスと env を使える", async (t) => {
  const { load } = await worker(
    t,
    `import { WorkerEntrypoint, env } from "cloudflare:workers";
    export default class extends WorkerEntrypoint {
      async fetch(request) {
        return new Response(this.env.NAME + ":" + env.NAME);
      }
    }`,
    { vars: { NAME: "kz" } },
  );
  const { response } = await (await load()).fetch(new Request("http://x/"));
  assert.equal(await response!.text(), "kz:kz");
});

test("KV / R2 のバインディングが env に入る", async (t) => {
  const { load } = await worker(
    t,
    `export default {
      async fetch(request, env) {
        await env.KV.put("k", "kv-value");
        await env.BUCKET.put("o", "r2-value");
        return new Response((await env.KV.get("k")) + "," + (await (await env.BUCKET.get("o")).text()));
      }
    }`,
    { kvNamespaces: [{ binding: "KV" }], r2Buckets: [{ binding: "BUCKET", bucketName: "b" }] },
  );
  const { response } = await (await load()).fetch(new Request("http://x/"));
  assert.equal(await response!.text(), "kv-value,r2-value");
});

test("Node API が返す ArrayBuffer / Uint8Array に Worker 側の instanceof が通る", async (t) => {
  const { load } = await worker(
    t,
    `export default {
      async fetch() {
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("x"));
        const bytes = new TextEncoder().encode("x");
        return Response.json([digest instanceof ArrayBuffer, bytes instanceof Uint8Array]);
      }
    }`,
  );
  const { response } = await (await load()).fetch(new Request("http://x/"));
  assert.deepEqual(await response!.json(), [true, true]);
});

test("相対 import と Text モジュールを読み込める", async (t) => {
  const { load } = await worker(t, {
    "worker/index.js": `import { greet } from "./lib/greet.js"; import tpl from "./tpl.html";
      export default { fetch() { return new Response(greet() + tpl); } }`,
    "worker/lib/greet.js": `export const greet = () => "hello ";`,
    "worker/tpl.html": "<b>tpl</b>",
  });
  const { response } = await (await load()).fetch(new Request("http://x/"));
  assert.equal(await response!.text(), "hello <b>tpl</b>");
});

test("nodejs_compat を指定すると許可した node: モジュールと Buffer が使える", async (t) => {
  const { load } = await worker(
    t,
    `import { Buffer as B } from "node:buffer"; import { EventEmitter } from "node:events";
    export default { fetch() { return new Response(B.from("ok").toString("base64") + typeof EventEmitter + typeof Buffer + process.env.A); } }`,
    { compatibilityFlags: ["nodejs_compat"], vars: { A: "x" } },
  );
  const { response } = await (await load()).fetch(new Request("http://x/"));
  assert.equal(await response!.text(), "b2s=functionfunctionx");
});

test("nodejs_compat なしの node: import と、許可していない node: モジュールは読み込みで失敗する", async (t) => {
  const noFlag = await worker(t, `import { Buffer } from "node:buffer"; export default { fetch() { return new Response(Buffer.from("x")); } }`);
  await assert.rejects(noFlag.load(), /nodejs_compat/);
  const denied = await worker(t, `import { readFileSync } from "node:fs"; export default { fetch() { return new Response(readFileSync("/etc/passwd")); } }`, {
    compatibilityFlags: ["nodejs_compat"],
  });
  await assert.rejects(denied.load(), (err: Error) => err instanceof WorkerError && /node:fs/.test(err.message));
});

test("Worker のディレクトリの外は import できない", async (t) => {
  const { load } = await worker(t, { "worker/index.cjs": `require("../_manifest.json"); exports.default = { fetch() {} };` });
  await assert.rejects(load(), WorkerError);
});

test("fetch ハンドラがないと読み込みで失敗する", async (t) => {
  const { load } = await worker(t, `addEventListener("fetch", () => {}); export default {}`);
  await assert.rejects(load(), WorkerError);
});

test("トップレベルの構文エラーや例外は WorkerError になる", async (t) => {
  await assert.rejects((await worker(t, { "worker/index.cjs": `module.exports = {` })).load(), WorkerError);
  await assert.rejects((await worker(t, `throw new Error("boom"); export default {}`)).load(), /boom/);
});

test("同期処理が CPU 時間の上限を超えると打ち切る", async (t) => {
  const top = await worker(t, `while (true) {} export default { fetch() {} }`);
  await assert.rejects(top.load(), WorkerError);

  const { load } = await worker(t, `export default { fetch() { while (true) {} } }`);
  const w = await load();
  const result = await w.fetch(new Request("http://x/"));
  assert.equal(result.response, null);
  assert.match(String(result.error), /timed out/);
  const again = await w.fetch(new Request("http://x/"));
  assert.match(String(again.error), /timed out/);
});

test("ハンドラの例外と passThroughOnException が結果に反映される", async (t) => {
  const { load } = await worker(t, `export default { fetch(req, env, ctx) { ctx.passThroughOnException(); throw new Error("x"); } }`);
  const result = await (await load()).fetch(new Request("http://x/"));
  assert.equal(result.response, null);
  assert.equal(result.passThrough, true);
});

test("Response 以外を返すとエラーになる", async (t) => {
  const { load } = await worker(t, `export default { fetch() { return "text"; } }`);
  const result = await (await load()).fetch(new Request("http://x/"));
  assert.equal(result.response, null);
  assert.match(String(result.error), /Response/);
});

test("Runtime は同じリリースなら読み込み済みの Worker を使い回す", async (t) => {
  const a = await worker(t, `export default { fetch() { return new Response("a"); } }`);
  const runtime = new Runtime({ siteDir: a.store.siteDir, idleMs: 60_000, cpuTimeoutMs: 200 });
  t.after(() => runtime.close());
  const first = await runtime.get(a.r);
  assert.equal(await runtime.get(a.r), first);
  runtime.evict();
  assert.notEqual(await runtime.get(a.r), first);
});

test("Runtime は一定時間使われていない Worker を捨てる", async (t) => {
  const a = await worker(t, `export default { fetch() { return new Response("a"); } }`);
  const runtime = new Runtime({ siteDir: a.store.siteDir, idleMs: 1000, cpuTimeoutMs: 200 });
  t.after(() => runtime.close());
  await runtime.get(a.r);
  runtime.sweep(Date.now() + 2000);
  assert.equal(runtime.loaded, false);
});

test("再デプロイで差し替えた古い Worker のコンテキストは GC で解放される", async (t) => {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (!gc) return t.skip("--expose-gc が必要");
  const a = await worker(t, `export default { fetch() { return new Response("v1"); } }`);
  const runtime = new Runtime({ siteDir: a.store.siteDir, idleMs: 60_000, cpuTimeoutMs: 200 });
  t.after(() => runtime.close());

  let collected = false;
  const registry = new FinalizationRegistry(() => (collected = true));
  await (async () => {
    const old = await runtime.get(a.r);
    await old.fetch(new Request("http://x/"));
    registry.register(old.context, "old");
  })();

  const v2 = toCjs(t, { "worker/index.js": `export default { fetch() { return new Response("v2"); } }` });
  const next = await a.store.createRelease(manifest(), [{ path: "worker/index.cjs", data: Buffer.from(v2["worker/index.cjs"]) }]);
  await a.store.activate(next);
  runtime.install(await runtime.preload(next));

  for (let i = 0; i < 20 && !collected; i++) {
    gc();
    await tick();
  }
  assert.equal(collected, true);
});
