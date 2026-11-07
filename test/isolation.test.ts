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
    otherDb: path.join(dataDir, "sites", other, "data.sqlite"),
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
