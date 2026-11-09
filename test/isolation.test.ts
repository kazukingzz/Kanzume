import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { isRoot, type ChildWorker } from "../src/runtime/process.ts";
import { Runtime } from "../src/runtime/runtime.ts";
import { Store, type Release } from "../src/store.ts";
import { manifest, tmpDir } from "./helpers.ts";

/**
 * Worker を子プロセスで動かしたとき、node:vm から抜け出したコードでも
 * 本体のデータ・ほかのサイト・本体の環境変数に触れないこと
 */

// vm の外（子プロセスの本物の process）を取り出す。node:vm はセキュリティ境界ではないので、Worker のコードはこれができる
const ESCAPE = `const host = (function () { return this.constructor.constructor("return process")(); })();`;

const PROBE = `${ESCAPE}
module.exports = {
  async fetch(request, env) {
    const fs = host.getBuiltinModule("fs");
    const url = new URL(request.url);
    const out = {};
    const tryRead = (name, file) => {
      try { fs.readFileSync(file); out[name] = "read"; } catch (e) { out[name] = e.code || String(e); }
    };
    tryRead("admin", url.searchParams.get("admin"));
    tryRead("otherDb", url.searchParams.get("otherDb"));
    tryRead("otherSettings", url.searchParams.get("otherSettings"));
    tryRead("ownSettings", url.searchParams.get("ownSettings"));
    // シークレットの入った settings.json を差し替えられないこと（サブドメインの乗っ取りに使える）
    try {
      fs.unlinkSync(url.searchParams.get("ownSettings"));
      out.replaceSettings = "replaced";
    } catch (e) { out.replaceSettings = e.code || String(e); }
    // node:sqlite は Node の権限モデルを通らないので、ほかのサイトの DB は uid で守る
    try {
      const { DatabaseSync } = host.getBuiltinModule("node:sqlite");
      const db = new DatabaseSync(":memory:");
      db.exec("ATTACH '" + url.searchParams.get("otherDb") + "' AS o");
      db.prepare("SELECT count(*) FROM o.kv").get();
      out.attach = "read";
    } catch (e) { out.attach = e.code || String(e.message); }
    out.backupUrl = host.env.KANZUME_BACKUP_URL ?? null;
    try { host.getBuiltinModule("child_process").execFileSync("id"); out.spawn = "ran"; } catch (e) { out.spawn = e.code || String(e); }
    out.uid = typeof host.getuid === "function" ? host.getuid() : null;
    out.pid = host.pid;
    await env.KV.put("k", "v");
    await env.BUCKET.put("o", "r2");
    out.kv = await env.KV.get("k");
    out.r2 = await (await env.BUCKET.get("o")).text();
    if (url.pathname === "/crash") setTimeout(() => host.exit(1), 10);
    return Response.json(out);
  },
};`;

const BINDINGS = { kvNamespaces: [{ binding: "KV" }], r2Buckets: [{ binding: "BUCKET", bucketName: "bk" }] };

async function site(dataDir: string, name: string, source = PROBE): Promise<Release> {
  const store = new Store(path.join(dataDir, "sites", name));
  await store.init();
  const r = await store.createRelease(manifest({ name, ...BINDINGS }), [{ path: "worker/index.cjs", data: Buffer.from(source) }]);
  await store.activate(r);
  fs.writeFileSync(path.join(store.siteDir, "settings.json"), JSON.stringify({ secrets: { TOKEN: name } }));
  return r;
}

function setup(t: TestContext, options: { maxWorkers?: number; idleMs?: number } = {}) {
  const dataDir = tmpDir(t);
  fs.writeFileSync(path.join(dataDir, "admin.json"), "{}", { mode: 0o600 });
  const runtime = new Runtime({ idleMs: options.idleMs ?? 60_000, cpuTimeoutMs: 1000, maxWorkers: options.maxWorkers, isolation: "process", dataDir });
  t.after(() => runtime.close());
  return { dataDir, runtime };
}

const probeUrl = (dataDir: string, own: string, other: string, p = "/") =>
  `http://x${p}?` +
  new URLSearchParams({
    admin: path.join(dataDir, "admin.json"),
    otherDb: path.join(dataDir, "sites", other, "data", "data.sqlite"),
    otherSettings: path.join(dataDir, "sites", other, "settings.json"),
    ownSettings: path.join(dataDir, "sites", own, "settings.json"),
  });

async function probe(runtime: Runtime, r: Release, url: string) {
  const { response, error } = await (await runtime.get(r)).fetch(new Request(url));
  assert.equal(error, null, String((error as Error | null)?.stack));
  return (await response!.json()) as Record<string, unknown>;
}

test("vm から抜け出しても、本体のデータ・ほかのサイト・本体の環境変数・子プロセスの起動に届かず、自分の KV / R2 は使える", async (t) => {
  process.env.KANZUME_BACKUP_URL = "s3://secret@example/bucket";
  t.after(() => delete process.env.KANZUME_BACKUP_URL);
  const { dataDir, runtime } = setup(t);
  const a = await site(dataDir, "a");
  const b = await site(dataDir, "b");
  // b の data.sqlite を作っておく
  await probe(runtime, b, probeUrl(dataDir, "b", "a"));

  const out = await probe(runtime, a, probeUrl(dataDir, "a", "b"));
  assert.equal(out.admin, "ERR_ACCESS_DENIED");
  assert.equal(out.otherDb, "ERR_ACCESS_DENIED");
  assert.equal(out.otherSettings, "ERR_ACCESS_DENIED");
  assert.equal(out.backupUrl, null);
  assert.equal(out.spawn, "ERR_ACCESS_DENIED");
  assert.equal(out.kv, "v");
  assert.equal(out.r2, "r2");
  assert.notEqual(out.pid, process.pid);

  const outB = await probe(runtime, b, probeUrl(dataDir, "b", "a"));
  if (isRoot()) {
    assert.notEqual(out.replaceSettings, "replaced", "settings.json は消せない（サイトのディレクトリには書けない）");
    assert.notEqual(out.attach, "read", "ほかのサイトの DB は node:sqlite でも開けない");
    // root でないときは自分のサイトの settings.json は読める（中身は env に渡している自分のシークレットだけ）
    assert.notEqual(out.ownSettings, "read", "シークレットの入った settings.json は子から読めない（IPC で渡す）");
    assert.notEqual(out.uid, 0);
    assert.notEqual(outB.uid, 0);
    assert.notEqual(out.uid, outB.uid, "サイトごとに別のユーザーで動く");
  }
});

test("子プロセスが落ちても本体は動き続け、次のリクエストで起動し直す", async (t) => {
  const { dataDir, runtime } = setup(t);
  const a = await site(dataDir, "a");
  const first = await probe(runtime, a, probeUrl(dataDir, "a", "b", "/crash"));
  const handle = (await runtime.get(a)) as ChildWorker;
  await new Promise<void>((resolve) => {
    const check = () => (handle.closed ? resolve() : setTimeout(check, 10));
    check();
  });
  const second = await probe(runtime, a, probeUrl(dataDir, "a", "b"));
  assert.notEqual(second.pid, first.pid);
  assert.equal(second.kv, "v");
});

test("使われない子と、最大数を超えた古い子は止まる", async (t) => {
  const { dataDir, runtime } = setup(t, { maxWorkers: 1, idleMs: 1000 });
  const a = await site(dataDir, "a");
  const b = await site(dataDir, "b");
  const wa = (await runtime.get(a)) as ChildWorker;
  const wb = (await runtime.get(b)) as ChildWorker;
  await waitClosed(wa);
  assert.equal(wb.closed, false);
  runtime.sweep(Date.now() + 2000);
  await waitClosed(wb);
  assert.equal(runtime.size, 0);
});

test("再デプロイで新しい子に入れ替わり、読み込めないデプロイでは古い子のまま動く", async (t) => {
  const { dataDir, runtime } = setup(t);
  const v1 = await site(dataDir, "a", `module.exports = { fetch: () => new Response("v1") };`);
  const w1 = (await runtime.get(v1)) as ChildWorker;
  assert.equal(await (await w1.fetch(new Request("http://x/"))).response!.text(), "v1");

  const store = new Store(v1.siteDir);
  const broken = await store.createRelease(manifest({ name: "a" }), [{ path: "worker/index.cjs", data: Buffer.from("throw new Error('boom')") }]);
  await assert.rejects(runtime.preload(broken), /boom/);
  assert.equal(w1.closed, false);

  const v2 = await store.createRelease(manifest({ name: "a" }), [{ path: "worker/index.cjs", data: Buffer.from(`module.exports = { fetch: () => new Response("v2") };`) }]);
  const w2 = (await runtime.preload(v2)) as ChildWorker;
  runtime.install(w2);
  await waitClosed(w1);
  assert.equal(await (await (await runtime.get(v2)).fetch(new Request("http://x/"))).response!.text(), "v2");
});

async function waitClosed(w: ChildWorker) {
  for (let i = 0; i < 300 && !w.closed; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(w.closed, true);
}

// 訪問者や Worker の不具合で、子プロセス（同じサイトのほかのリクエスト）や本体を落とさない
const EDGE = `${ESCAPE}
module.exports = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/error-response") return Response.error();
    if (url.pathname === "/bad-header") return new Response("x", { headers: { location: url.searchParams.get("next") } });
    if (url.pathname === "/long-error") throw new Error("あ".repeat(6000));
    if (url.pathname === "/bad-ipc") {
      // 本体への知らせのパイプ（fd 3）に、壊れた行・形の違う行・Node の内部メッセージに似た行を書く
      const fs = host.getBuiltinModule("fs");
      const w = (v) => fs.writeSync(3, v);
      w('{"type":"done","id":"x","logs":1}\\n');
      w('{"type":"done","id":"x","logs":[{"message":{"toString":1}}],"exceptions":[{"name":[1,2],"message":{}}]}\\n');
      w('{"cmd":"NODE_HANDLE_ACK"}\\n');
      w('not json\\n');
      w(new Uint8Array([0, 0, 0, 4, 0xde, 0xad, 0xbe, 0xef, 10]));
      w('"just a string"\\n');
      w("[1,2,3]\\n");
      return new Response("sent");
    }
    if (url.pathname === "/pass") {
      ctx.passThroughOnException();
      throw new Error("pass me");
    }
    if (url.pathname === "/length") return Response.json({ length: request.headers.get("content-length"), body: (await request.text()).length });
    if (url.pathname === "/stream") {
      let i = 0;
      return new Response(new ReadableStream({ async pull(c) { await new Promise((r) => setTimeout(r, 50)); if (i++ < 5) c.enqueue(new TextEncoder().encode("x")); else c.close(); } }));
    }
    if (url.pathname === "/slow") {
      ctx.waitUntil(new Promise((r) => setTimeout(r, 300)).then(() => env.KV.put("slow", "done")));
      return new Response("later");
    }
    return Response.json({ url: request.url, host: request.headers.get("host"), id: request.headers.get("x-kanzume-id"), pid: host.pid });
  },
};`;

test("訪問者が内部用のヘッダーを付けても、URL や ID を偽れず子も落ちない。Host は Worker に届く", async (t) => {
  const { dataDir, runtime } = setup(t);
  const r = await site(dataDir, "a", EDGE);
  const w = await runtime.get(r);
  const res = await w.fetch(new Request("http://a.example.com/path?q=1", { headers: { host: "a.example.com", "x-kanzume-url": "x", "x-kanzume-id": "spoof" } }));
  const body = (await res.response!.json()) as { url: string; host: string; id: string | null; pid: number };
  assert.equal(body.url, "http://a.example.com/path?q=1");
  assert.equal(body.host, "a.example.com");
  assert.equal(body.id, null, "内部用のヘッダーは Worker に見せない");
  await Promise.all(res.waitUntil);
  const again = (await (await w.fetch(new Request("http://a.example.com/"))).response!.json()) as { pid: number };
  assert.equal(again.pid, body.pid, "子は落ちていない");
});

test("Worker の不正な応答や長い例外は、そのリクエストだけの失敗になり、子は動き続ける", async (t) => {
  const { dataDir, runtime } = setup(t);
  const r = await site(dataDir, "a", EDGE);
  const w = (await runtime.get(r)) as ChildWorker;
  const pid = w.pid;
  const bad = await w.fetch(new Request("http://x/error-response"));
  assert.equal(bad.response?.status ?? 500, 500);
  const header = await w.fetch(new Request("http://x/bad-header?next=%01"));
  assert.equal(header.response?.status ?? 500, 500);
  const long = await w.fetch(new Request("http://x/long-error"));
  assert.equal(long.response, null);
  assert.equal((long.error as Error).message, "あ".repeat(6000), "長い例外もそのまま届く");
  await Promise.all([...bad.waitUntil, ...header.waitUntil, ...long.waitUntil]);
  assert.equal(w.closed, false);
  assert.equal(w.pid, pid);
  assert.equal((await (await w.fetch(new Request("http://x/"))).response!.json() as { pid: number }).pid, pid);
});

test("子が本体への知らせのパイプに不正な行を書いても本体は落ちない", async (t) => {
  const { dataDir, runtime } = setup(t);
  const r = await site(dataDir, "a", EDGE);
  const w = (await runtime.get(r)) as ChildWorker;
  const res = await w.fetch(new Request("http://x/bad-ipc"));
  assert.equal(await res.response!.text(), "sent");
  await Promise.all(res.waitUntil);
  assert.equal((await (await w.fetch(new Request("http://x/"))).response!.json() as { pid: number }).pid, w.pid);
});

test("再デプロイで外した子も、処理中の waitUntil は最後まで動く", async (t) => {
  const { dataDir, runtime } = setup(t);
  const v1 = await site(dataDir, "a", EDGE);
  const w1 = (await runtime.get(v1)) as ChildWorker;
  const slow = await w1.fetch(new Request("http://x/slow"));
  assert.equal(await slow.response!.text(), "later");
  const store = new Store(v1.siteDir);
  const v2 = await store.createRelease(manifest({ name: "a", ...BINDINGS }), [{ path: "worker/index.cjs", data: Buffer.from(EDGE) }]);
  runtime.install((await runtime.preload(v2)) as ChildWorker);
  assert.equal(w1.closed, false, "処理中なのですぐには止めない");
  await Promise.all(slow.waitUntil);
  await waitClosed(w1);
  const { siteDb } = await import("../src/bindings/db.ts");
  const { KVNamespace } = await import("../src/bindings/kv.ts");
  assert.equal(await new KVNamespace(siteDb(v1.siteDir), "KV").get("slow"), "done");
});

test("大きなヘッダーでも、HEAD の passThroughOnException・Content-Length・長いストリームが正しく扱われ、待ち状態が残らない", async (t) => {
  const { dataDir, runtime } = setup(t);
  const r = await site(dataDir, "a", EDGE);
  const w = (await runtime.get(r)) as ChildWorker;

  // 本体が受けられる大きさのヘッダー（子に転送すると URL などが増える）でも、子が断らずに処理する
  const big = await w.fetch(new Request("http://x/?" + "q".repeat(8000), { headers: { "x-forwarded-for": "a".repeat(8000) } }));
  assert.equal(big.response?.status, 200);
  await Promise.all(big.waitUntil);
  assert.equal(w.busy, false, "待ち状態が残らない");

  // HEAD で例外を出しても、passThroughOnException と例外の中身が届く
  const head = await w.fetch(new Request("http://x/pass", { method: "HEAD" }));
  assert.equal(head.response, null);
  assert.equal(head.passThrough, true);
  assert.equal((head.error as Error).message, "pass me");
  await Promise.all(head.waitUntil);

  // Content-Length が Worker に届く
  const len = await w.fetch(new Request("http://x/length", { method: "POST", body: "hello", headers: { "content-length": "5" } }));
  assert.deepEqual(await len.response!.json(), { length: "5", body: 5 });
  await Promise.all(len.waitUntil);

  // ストリームを送っている間は使用中として扱う（追い出しや停止で切らない）
  const stream = await w.fetch(new Request("http://x/stream"));
  assert.equal(w.busy, true);
  assert.equal(await stream.response!.text(), "xxxxx");
  await Promise.all(stream.waitUntil);
  assert.equal(w.busy, false);
});

test("止める途中の子もリソースに出て、サイトの削除（now）や本体の終了ではすぐに止まる", async (t) => {
  const { dataDir, runtime } = setup(t);
  const v1 = await site(dataDir, "a", EDGE);
  const w1 = (await runtime.get(v1)) as ChildWorker;
  const slow = await w1.fetch(new Request("http://x/slow"));
  await slow.response!.text();
  const store = new Store(v1.siteDir);
  const v2 = await store.createRelease(manifest({ name: "a", ...BINDINGS }), [{ path: "worker/index.cjs", data: Buffer.from(EDGE) }]);
  const w2 = (await runtime.preload(v2)) as ChildWorker;
  runtime.install(w2);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(w1.closed, false);
  assert.deepEqual(runtime.processes().map((p) => p.pid).sort(), [w1.pid, w2.pid].sort(), "止める途中の子もリソースに出る");

  // デプロイの前に古いリリースを読んだリクエストは、新しい子で受ける（新しい子を追い出さない）
  assert.equal(await runtime.get(v1), w2);

  runtime.evict(v1.siteDir, { now: true });
  await waitClosed(w1);
  await waitClosed(w2);
  assert.deepEqual(runtime.processes(), []);
});
