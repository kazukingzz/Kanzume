import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
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

test("アップロードしたファイルはサイトのリポジトリのコミットになり、clone で取り出せる", async (t) => {
  const { upload, sites, repos, history } = await start(t);
  await sites.ensure("blog");
  assert.equal((await upload("blog", { "index.html": "v1" })).status, 200);
  assert.equal(await repos.exists("blog"), true, "リポジトリがなければ作る");
  const first = await repos.commit("blog", "refs/heads/main");
  assert.equal(first.subject, "ファイルをアップロード（1 ファイル・静的サイト）");
  assert.deepEqual((await repos.tree("blog", "main")).map((f) => f.path), ["public/index.html", "wrangler.jsonc"], "静的サイトは git push し直せる形（wrangler.jsonc と public/）で保存する");
  assert.equal(JSON.parse((await repos.readFile("blog", first.sha, "wrangler.jsonc"))!).name, "blog");
  assert.equal(history.latest("blog")?.source.sha, first.sha, "デプロイ履歴にコミットが付く");

  const res = await upload("blog", { "index.html": "v2", ".gitignore": "*.html\n" });
  assert.equal(((await res.json()) as { commit: string }).commit, (await repos.commit("blog", "refs/heads/main")).sha);
  const log = await repos.log("blog", "main");
  assert.equal(log.length, 2, "前のコミットの次に積む");
  assert.deepEqual((await repos.tree("blog", "main")).map((f) => f.path), ["public/.gitignore", "public/index.html", "wrangler.jsonc"], "前のファイルは引き継がず、.gitignore があってもすべて入れる");

  const dest = path.join(tmpDir(t), "clone");
  execFileSync("git", ["clone", "--quiet", repos.path("blog"), dest]);
  assert.equal(fs.readFileSync(path.join(dest, "public/index.html"), "utf8"), "v2");
});

test("wrangler の name はサイトの ID にそろえて保存し、デプロイに失敗したら作ったリポジトリは残さない", async (t) => {
  const { upload, sites, repos } = await start(t);
  await sites.ensure("api");
  const config = `{\n  // コメントは残る\n  "name": "something-else",\n  "main": "index.js",\n  "compatibility_date": "2026-10-01"\n}\n`;
  assert.equal((await upload("api", { "wrangler.jsonc": config, "index.js": "export default { fetch: () => new Response('ok') };" })).status, 200);
  const saved = (await repos.readFile("api", (await repos.commit("api", "refs/heads/main")).sha, "wrangler.jsonc"))!;
  assert.equal(saved, config.replace("something-else", "api"));

  await sites.ensure("broken");
  const bad = await upload("broken", { "wrangler.jsonc": JSON.stringify({ name: "broken", main: "index.js" }), "index.js": "syntax error (" });
  assert.equal(bad.status, 400);
  assert.equal(await repos.exists("broken"), false);
});
