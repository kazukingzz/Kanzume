import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { test, type TestContext } from "node:test";
import { loadConfig } from "../src/config.ts";
import { createServer } from "../src/server.ts";
import { rawTar, rawTarEntry, tmpDir } from "./helpers.ts";

const cred = (id: string, userId?: string) => ({ id, publicKey: "AAAA", counter: 0, createdAt: new Date().toISOString(), userId });

async function start(t: TestContext, env: Record<string, string> = {}) {
  const app = await createServer(loadConfig({ KANZUME_DATA_DIR: tmpDir(t), KANZUME_SETUP_TOKEN: "setup", ...env }));
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    app.runtime.close();
    await new Promise((resolve) => app.server.close(resolve));
    await app.state.flush();
  });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  await app.state.addCredential(cred("admin"));
  const adminCookie = `kanzume_session=${await app.state.createSession()}`;
  const upload = (site: string, files: Record<string, string> | Buffer, cookie = adminCookie) =>
    fetch(`${base}/_admin/kanzume/api/sites/${site}/deploy-upload`, {
      method: "POST",
      headers: { cookie, origin: base, "content-type": "application/gzip" },
      body: new Uint8Array(Buffer.isBuffer(files) ? files : gzipSync(rawTar(Object.entries(files).map(([p, d]) => rawTarEntry(p, Buffer.from(d)))))),
    });
  const site = (host: string, p = "/") => fetch(`${base}${p}`, { headers: { "x-forwarded-host": host } });
  const sitesList = async () =>
    ((await (await fetch(`${base}/_admin/kanzume/api/sites`, { headers: { cookie: adminCookie, origin: base } })).json()) as { sites: { name: string; kind: string | null }[] }).sites;
  return { ...app, base, upload, site, sitesList };
}

test("設定ファイルのないファイルは、静的サイトとしてデプロイされる", async (t) => {
  const { upload, site, sites, sitesList, history } = await start(t);
  await sites.ensure("blog");
  const res = await upload("blog", { "index.html": "<h1>hello</h1>", "css/a.css": "body{}" });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(((await res.json()) as { static: boolean }).static, true);
  assert.equal(await (await site("blog.localhost")).text(), "<h1>hello</h1>");
  assert.equal(await (await site("blog.localhost", "/css/a.css")).text(), "body{}");
  assert.deepEqual((await sitesList()).map((s) => [s.name, s.kind]), [["blog", "static"]]);
  const files = sites.get("blog")!.get()!;
  assert.equal(files.manifest.main, null);
  assert.match(history.latest("blog")?.source.commitMessage ?? "", /ファイルをアップロード（2 ファイル・静的サイト）/);
});

test("wrangler の設定があれば、その設定でバンドルして Worker として動く。name が違ってもサイト名でデプロイする", async (t) => {
  const { upload, site, sites, sitesList } = await start(t);
  await sites.ensure("api");
  const res = await upload("api", {
    "wrangler.jsonc": JSON.stringify({ name: "something-else", main: "src/index.js", compatibility_date: "2026-10-01" }),
    "src/index.js": `import { msg } from "./msg.js"; export default { fetch: () => new Response(msg) };`,
    "src/msg.js": `export const msg = "from worker";`,
  });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(await (await site("api.localhost")).text(), "from worker");
  assert.deepEqual((await sitesList()).map((s) => [s.name, s.kind]), [["api", "dynamic"]]);
  assert.equal(sites.has("something-else"), false);
});

test("権限のないメンバー・存在しないサイト・上限超え・壊れた本文は弾く", async (t) => {
  const { upload, sites, state } = await start(t, { KANZUME_MAX_UPLOAD_MB: "1" });
  await sites.ensure("blog");
  await sites.ensure("shop");
  const user = await state.createUser("参加者", "member", ["shop"]);
  await state.addCredential(cred("m", user.id));
  const memberCookie = `kanzume_session=${await state.createSession(user.id)}`;
  assert.equal((await upload("blog", { "index.html": "x" }, memberCookie)).status, 403);
  assert.equal((await upload("shop", { "index.html": "x" }, memberCookie)).status, 200, "自分のサイトにはメンバーもデプロイできる");
  assert.equal(sites.root, null, "メンバーのデプロイではルートにしない");
  assert.equal((await upload("nope", { "index.html": "x" })).status, 404);
  assert.equal((await upload("blog", Buffer.alloc(2 * 1024 * 1024))).status, 413);
  assert.equal((await upload("blog", Buffer.from("not gzip"))).status, 400);
  assert.equal((await upload("blog", {})).status, 400);
  assert.equal((await upload("blog", { "index.html": "x", "../evil.txt": "x" })).status, 400, "サイトの外を指すパスは受け付けない");
});
