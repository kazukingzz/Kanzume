import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { closeSiteDb } from "../src/bindings/db.ts";
import { loadConfig } from "../src/config.ts";
import { createServer } from "../src/server.ts";
import { rawTarEntry, rawTarGz, tarGz, tmpDir, toCjs } from "./helpers.ts";

async function start(t: TestContext, env: Record<string, string> = {}) {
  const dataDir = tmpDir(t);
  const config = loadConfig({ KANZUME_DATA_DIR: dataDir, KANZUME_SETUP_TOKEN: "setup", ...env });
  const { server, state, store } = await createServer(config);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    closeSiteDb(store.siteDir);
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const deploy = (body: Buffer, token = state.deployToken) =>
    fetch(`${base}/_api/deploy`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: new Uint8Array(body) });
  return { base, deploy, state, store };
}

function workerBundle(t: TestContext, source: string, extra: Record<string, unknown> = {}, assets: Record<string, string> = {}) {
  const config = JSON.stringify({ name: "app", main: "src/index.ts", compatibility_date: "2026-10-01", ...extra });
  return tarGz(t, { "wrangler.jsonc": config, ...toCjs(t, { "worker/index.js": source }), ...assets });
}

test("何もデプロイしていないときはトップに案内を出し、それ以外は 404", async (t) => {
  const { base } = await start(t);
  const top = await fetch(`${base}/`);
  assert.equal(top.status, 200);
  assert.match(await top.text(), /まだサイトがデプロイされていません/);
  assert.equal((await fetch(`${base}/about`)).status, 404);
});

test("Token がないか違うとデプロイできない", async (t) => {
  const { deploy } = await start(t);
  const body = tarGz(t, { "wrangler.json": JSON.stringify({ name: "a", assets: {} }), "assets/index.html": "x" });
  assert.equal((await deploy(body, "")).status, 401);
  assert.equal((await deploy(body, "kz_wrong")).status, 401);
});

test("静的サイトをデプロイするとルートで配信される", async (t) => {
  const { base, deploy } = await start(t);
  const body = tarGz(t, {
    "wrangler.toml": `name = "site"\n[assets]\ndirectory = "./dist"\n`,
    "assets/index.html": "<h1>site</h1>",
    "assets/about.html": "about",
    "assets/_next/static/app.js": "next",
  });
  const res = await deploy(body);
  assert.equal(res.status, 200);
  const json = (await res.json()) as { url: string; name: string };
  assert.equal(json.name, "site");
  assert.equal(json.url, `${base}/`);

  assert.equal(await (await fetch(`${base}/`)).text(), "<h1>site</h1>");
  assert.equal(await (await fetch(`${base}/about`)).text(), "about");
  assert.equal(await (await fetch(`${base}/_next/static/app.js`)).text(), "next");
  const html = await fetch(`${base}/about.html`, { redirect: "manual" });
  assert.equal(html.headers.get("location"), "/about");
  assert.equal((await fetch(`${base}/missing`)).status, 404);
});

test("Worker の fetch ハンドラにはそのままの URL が渡り、KV が使える", async (t) => {
  const { base, deploy } = await start(t);
  const source = `export default {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (url.pathname === "/go") return Response.redirect(url.origin + "/done", 302);
      const n = Number((await env.KV.get("n")) ?? 0) + 1;
      await env.KV.put("n", String(n));
      return Response.json({
        url: request.url,
        ip: request.headers.get("cf-connecting-ip"),
        n,
        body: request.method === "POST" ? await request.text() : null,
      });
    }
  }`;
  const res = await deploy(workerBundle(t, source, { kv_namespaces: [{ binding: "KV", id: "x" }] }));
  assert.equal(res.status, 200, await res.clone().text());

  const first = await (await fetch(`${base}/hello?q=1`)).json();
  assert.deepEqual(first, { url: `${base}/hello?q=1`, ip: "127.0.0.1", n: 1, body: null });
  const post = (await (await fetch(`${base}/p`, { method: "POST", body: "payload" })).json()) as { body: string; n: number };
  assert.equal(post.body, "payload");
  assert.equal(post.n, 2);
  const redirect = await fetch(`${base}/go`, { redirect: "manual" });
  assert.equal(redirect.headers.get("location"), `${base}/done`);
});

test("アセットがあればアセット、なければ Worker が応答する（run_worker_first で逆転できる）", async (t) => {
  const { base, deploy } = await start(t);
  const source = `export default { fetch(request) { return new Response("worker:" + new URL(request.url).pathname); } }`;
  const assets = { "assets/index.html": "index", "assets/api/static.txt": "static" };
  await deploy(workerBundle(t, source, { assets: { directory: "public" } }, assets));
  assert.equal(await (await fetch(`${base}/`)).text(), "index");
  assert.equal(await (await fetch(`${base}/other`)).text(), "worker:/other");

  await deploy(workerBundle(t, source, { assets: { directory: "public", run_worker_first: ["/api/*"] } }, assets));
  assert.equal(await (await fetch(`${base}/api/static.txt`)).text(), "worker:/api/static.txt");
  assert.equal(await (await fetch(`${base}/`)).text(), "index");
});

test("SPA 指定時はナビゲーションのリクエストだけ index.html を返し、それ以外は Worker に渡す", async (t) => {
  const { base, deploy } = await start(t);
  const source = `export default { fetch() { return new Response("worker"); } }`;
  await deploy(workerBundle(t, source, { assets: { directory: "dist", not_found_handling: "single-page-application" } }, { "assets/index.html": "app" }));
  // fetch は sec-fetch-mode を上書きするので、ブラウザのナビゲーションを node:http で再現する
  const navigate = await new Promise<string>((resolve, reject) => {
    http.get(`${base}/users/1`, { headers: { "sec-fetch-mode": "navigate" } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve(body));
    }).on("error", reject);
  });
  assert.equal(navigate, "app");
  assert.equal(await (await fetch(`${base}/api/users`)).text(), "worker");
});

test("Worker の例外は 500 になり、passThroughOnException ならアセットにフォールバックする", async (t) => {
  const { base, deploy } = await start(t);
  await deploy(workerBundle(t, `export default { fetch() { throw new Error("boom"); } }`));
  assert.equal((await fetch(`${base}/`)).status, 500);

  const source = `export default { fetch(req, env, ctx) { ctx.passThroughOnException(); throw new Error("boom"); } }`;
  await deploy(workerBundle(t, source, { assets: { directory: "dist", run_worker_first: true } }, { "assets/index.html": "fallback" }));
  assert.equal(await (await fetch(`${base}/`)).text(), "fallback");
});

test("読み込みに失敗する Worker のデプロイは 400 になり、今の版が配信され続ける", async (t) => {
  const { base, deploy, store } = await start(t);
  await deploy(workerBundle(t, `export default { fetch() { return new Response("v1"); } }`));
  const before = store.get()!.id;

  const broken = await deploy(workerBundle(t, `throw new Error("top-level"); export default {}`));
  assert.equal(broken.status, 400);
  assert.match(((await broken.json()) as { error: string }).error, /top-level/);
  assert.equal(store.get()!.id, before);
  assert.equal(await (await fetch(`${base}/`)).text(), "v1");
});

test("再デプロイ中もリクエストは失敗せず、完了後は新しい版が応答する", async (t) => {
  const { base, deploy } = await start(t);
  await deploy(workerBundle(t, `export default { fetch() { return new Response("v1"); } }`));
  const v2 = workerBundle(t, `export default { fetch() { return new Response("v2"); } }`);

  const requests = Array.from({ length: 50 }, () => fetch(`${base}/`).then(async (r) => [r.status, await r.text()] as const));
  const deployed = await deploy(v2);
  const results = await Promise.all(requests);
  assert.equal(deployed.status, 200);
  for (const [status, text] of results) {
    assert.equal(status, 200);
    assert.ok(text === "v1" || text === "v2");
  }
  assert.equal(await (await fetch(`${base}/`)).text(), "v2");
});

test("不正なアップロードは 400 / 413 で拒否する", async (t) => {
  const { deploy } = await start(t, { KANZUME_MAX_UPLOAD_MB: "1" });
  const traversal = rawTarGz([rawTarEntry("wrangler.json", Buffer.from('{"name":"a","assets":{}}')), rawTarEntry("../evil", Buffer.from("x"))]);
  assert.equal((await deploy(traversal)).status, 400);
  assert.equal((await deploy(Buffer.from("not gzip"))).status, 400);
  assert.equal((await deploy(tarGz(t, { "assets/index.html": "x" }))).status, 400);
  assert.equal((await deploy(tarGz(t, { "wrangler.json": '{"name":"a","main":"src/index.ts"}' }))).status, 400);
  assert.equal((await deploy(Buffer.alloc(2 * 1024 * 1024))).status, 413);
});

test("予約パスはサイトに渡さない", async (t) => {
  const { base, deploy } = await start(t);
  await deploy(workerBundle(t, `export default { fetch() { return new Response("worker"); } }`));
  assert.equal(await (await fetch(`${base}/_health`)).text(), "ok");
  assert.equal((await fetch(`${base}/_api/unknown`)).status, 404);
  assert.equal((await fetch(`${base}/_api/deploy`)).status, 405);
  assert.equal((await fetch(`${base}/_admin/kanzume`)).status, 200);
  assert.equal(await (await fetch(`${base}/_other`)).text(), "worker");
});
