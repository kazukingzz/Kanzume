import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { closeSiteDb } from "../src/bindings/db.ts";
import { loadConfig } from "../src/config.ts";
import { createServer } from "../src/server.ts";
import { tarGz, tmpDir, toCjs } from "./helpers.ts";

async function start(t: TestContext) {
  const config = loadConfig({ KANZUME_DATA_DIR: tmpDir(t), KANZUME_SETUP_TOKEN: "setup" });
  const app = await createServer(config);
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    closeSiteDb(app.store.siteDir);
  });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const auth = { authorization: `Bearer ${app.state.deployToken}` };
  const deploy = (body: Buffer) => fetch(`${base}/_api/deploy`, { method: "POST", headers: auth, body: new Uint8Array(body) });
  return { ...app, base, auth, deploy };
}

function bundle(t: TestContext, source: string, extra: Record<string, string> = {}) {
  return tarGz(t, {
    "wrangler.jsonc": JSON.stringify({ name: "app", main: "src/index.ts", compatibility_date: "2026-10-01", assets: { directory: "public" } }),
    ...toCjs(t, { "worker/index.js": source }),
    "assets/index.html": "<h1>hi</h1>",
    ...extra,
  });
}

const META = {
  ".kanzume/meta.json": JSON.stringify({ source: { repository: "me/app", ref: "main", sha: "abc1234def", actor: "me", commitMessage: "初回" } }),
  ".kanzume/build.log": "$ wrangler deploy --dry-run\nTotal Upload: 1 KiB",
  ".kanzume/sources.json": JSON.stringify([
    { path: "src/index.ts", content: "export default {}" },
    { path: "../../etc/passwd", content: "x" },
  ]),
};

test("成功したデプロイがビルドログ・コミット情報・Kanzume のログ付きで履歴に残る", async (t) => {
  const { deploy, history } = await start(t);
  const res = await deploy(bundle(t, `export default { fetch() { return new Response("ok"); } }`, META));
  const { release } = (await res.json()) as { release: string };

  const [d] = history.list();
  assert.equal(d.status, "success");
  assert.equal(d.release, release);
  assert.deepEqual(d.source, { repository: "me/app", ref: "main", sha: "abc1234def", actor: "me", commitMessage: "初回" });
  const full = history.get(d.id)!;
  assert.match(full.buildLog, /wrangler deploy --dry-run/);
  assert.match(full.log, /Worker を読み込みました/);
  assert.match(full.log, /新しいリリースに切り替えました/);
});

test("読み込みに失敗したデプロイとビルド失敗の報告は失敗として履歴に残る", async (t) => {
  const { base, auth, deploy, history } = await start(t);
  await deploy(bundle(t, `throw new Error("top-level"); export default {}`, META));
  const report = await fetch(`${base}/_api/deploy/report`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ name: "app", error: "wrangler が失敗しました", buildLog: "✘ [ERROR] Could not resolve", source: { sha: "fff" } }),
  });
  assert.equal(report.status, 200);
  const unauthorized = await fetch(`${base}/_api/deploy/report`, { method: "POST", body: JSON.stringify({ name: "app" }) });
  assert.equal(unauthorized.status, 401);

  const [reported, loadFailed] = history.list();
  assert.equal(reported.status, "failed");
  assert.equal(reported.error, "wrangler が失敗しました");
  assert.match(history.get(reported.id)!.buildLog, /Could not resolve/);
  assert.equal(loadFailed.status, "failed");
  assert.match(loadFailed.error!, /top-level/);
  assert.equal(loadFailed.release, null);
});

test("Worker へのリクエストが console ログ・例外・サブリクエスト付きでイベントとして記録される", async (t) => {
  const { base, deploy, observability } = await start(t);
  const target = http.createServer((_, res) => res.end("upstream")).listen(0, "127.0.0.1");
  t.after(() => target.close());
  await new Promise((r) => target.once("listening", r));
  const upstream = `http://127.0.0.1:${(target.address() as AddressInfo).port}/x`;

  const source = `export default {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      console.log("path is", url.pathname, { n: 1 });
      if (url.pathname === "/boom") throw new TypeError("壊れた");
      if (url.pathname === "/sub") { await (await fetch(${JSON.stringify(upstream)})).text(); console.warn("fetched"); }
      ctx.waitUntil(new Promise((r) => setTimeout(r, 20)).then(() => console.log("after response")));
      return new Response("ok");
    }
  }`;
  await deploy(bundle(t, source));
  await fetch(`${base}/hello?x=1`);
  await fetch(`${base}/boom`);
  await fetch(`${base}/sub`);
  await fetch(`${base}/`);
  await new Promise((r) => setTimeout(r, 100));

  const events = observability.events();
  assert.equal(events.length, 4);
  const byPath = (p: string) => events.find((e) => e.path === p)!;
  const [asset, sub, boom, hello] = ["/", "/sub", "/boom", "/hello?x=1"].map(byPath);
  assert.deepEqual([asset.kind, asset.status, asset.path], ["asset", 200, "/"]);
  assert.deepEqual([boom.status, boom.outcome, boom.error], [500, "exception", "TypeError: 壊れた"]);
  assert.deepEqual([hello.kind, hello.method, hello.path, hello.outcome], ["worker", "GET", "/hello?x=1", "ok"]);

  const helloDetail = observability.event(hello.id)!.detail;
  assert.deepEqual(
    helloDetail.logs.map((l) => [l.level, l.message]),
    [
      ["log", "path is /hello { n: 1 }"],
      ["log", "after response"],
    ],
  );
  const subDetail = observability.event(sub.id)!.detail;
  assert.equal(subDetail.subrequests.length, 1);
  assert.equal(subDetail.subrequests[0].url, upstream);
  assert.equal(subDetail.subrequests[0].status, 200);
  assert.deepEqual(subDetail.logs.map((l) => l.level), ["log", "warn", "log"]);
  const stack = observability.event(boom.id)!.detail.exceptions[0].stack ?? "";
  assert.match(stack, /TypeError: 壊れた\n\s+at .*worker\/index\.cjs/);
  assert.doesNotMatch(stack, /src\/runtime|node:/);

  assert.deepEqual(observability.events({ result: "error" }).map((e) => e.id), [boom.id]);
  assert.deepEqual(observability.events({ kind: "asset" }).map((e) => e.id), [asset.id]);
  assert.deepEqual(observability.events({ q: "fetched" }).map((e) => e.id), [sub.id]);
  assert.deepEqual(observability.events({ before: events[0].id, limit: 1 }).map((e) => e.id), [events[1].id]);
});

test("同期処理の時間超過は exceededCpu として記録される", async (t) => {
  const config = loadConfig({ KANZUME_DATA_DIR: tmpDir(t), KANZUME_CPU_TIMEOUT_MS: "100" });
  const app = await createServer(config);
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => app.server.close(resolve)));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  await fetch(`${base}/_api/deploy`, {
    method: "POST",
    headers: { authorization: `Bearer ${app.state.deployToken}` },
    body: new Uint8Array(bundle(t, `export default { fetch() { while (true) {} } }`)),
  });
  assert.equal((await fetch(`${base}/x`)).status, 500);
  const [e] = app.observability.events();
  assert.equal(e.outcome, "exceededCpu");
});

test("メトリクスは期間内のリクエスト数・エラー数・実行時間をバケットごとに集計する", async (t) => {
  const { base, deploy, observability } = await start(t);
  await deploy(bundle(t, `export default { fetch(r) { if (new URL(r.url).pathname === "/e") throw new Error("x"); return new Response("ok"); } }`));
  for (let i = 0; i < 5; i++) await fetch(`${base}/ok`);
  for (let i = 0; i < 2; i++) await fetch(`${base}/e`);
  await fetch(`${base}/`);

  const m = observability.metrics("1h");
  assert.equal(m.totals.requests, 8);
  assert.equal(m.totals.worker, 7);
  assert.equal(m.totals.errors, 2);
  assert.equal(m.totals.statuses["5xx"], 2);
  assert.equal(m.buckets.length, 60);
  assert.equal(m.buckets.reduce((n, b) => n + b.ok + b.errors, 0), 8);
  assert.ok(m.totals.p50! > 0 && m.totals.p99! >= m.totals.p50!);

  const old = observability.metrics("1h", Date.now() + 2 * 3600e3);
  assert.equal(old.totals.requests, 0);
});

test("古いイベントは保持期間を過ぎると削除され、サイト削除でも消える", async (t) => {
  const { base, deploy, observability } = await start(t);
  await deploy(bundle(t, `export default { fetch() { return new Response("ok"); } }`));
  await fetch(`${base}/a`);
  observability.flush();
  observability.prune(Date.now() + 73 * 3600e3);
  assert.equal(observability.events().length, 0);
  await fetch(`${base}/b`);
  observability.clear();
  assert.equal(observability.events().length, 0);
});

test("管理 API でデプロイ中のコード（ソース・設定・変換後・アセット）を読める", async (t) => {
  const { store, deploy } = await start(t);
  await deploy(bundle(t, `export default { fetch() { return new Response("ok"); } }`, { ...META, "assets/logo.bin": "\u0000\u0001" }));
  const { listFiles, readFile } = await import("../src/admin/files.ts");
  const release = store.get()!;
  const groups = listFiles(release);
  assert.deepEqual(groups.source.map((f) => f.path), ["etc/passwd", "src/index.ts"]);
  assert.deepEqual(groups.config.map((f) => f.path), ["wrangler.jsonc"]);
  assert.deepEqual(groups.worker.map((f) => f.path), ["index.cjs"]);
  assert.deepEqual(groups.assets.map((f) => f.path), ["index.html", "logo.bin"]);

  assert.equal(readFile(release, "source", "src/index.ts")?.text, "export default {}");
  assert.match(readFile(release, "config", "wrangler.jsonc")!.text!, /"name":"app"/);
  assert.equal(readFile(release, "assets", "logo.bin")?.binary, true);
  assert.equal(readFile(release, "assets", "../_manifest.json"), null);
  assert.equal(readFile(release, "worker", "../../current"), null);
  assert.equal(readFile(release, "config", "_manifest.json"), null);
});
