import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { tmpDir, writeTree } from "./helpers.ts";
import { startApp } from "./fixtures.ts";

/** GitHub Actions 用の Action（action/deploy.mjs）を、そのまま動かして Kanzume にデプロイする */

const run = promisify(execFile);
const DEPLOY = path.join(import.meta.dirname, "..", "action", "deploy.mjs");

async function start(t: TestContext) {
  return startApp(t);
}

/** Action を実行する（GitHub の環境変数は消して、手元の git から情報を取る） */
async function action(dir: string, env: Record<string, string>) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GITHUB_")));
  try {
    const { stdout, stderr } = await run(process.execPath, [DEPLOY], { cwd: dir, env: { ...clean, ...env } });
    return { code: 0, output: stdout + stderr };
  } catch (err) {
    const e = err as { code: number; stdout: string; stderr: string };
    return { code: e.code, output: e.stdout + e.stderr };
  }
}

const staticProject = (t: TestContext) => {
  const dir = tmpDir(t);
  // name は使わない（デプロイ先は site）
  writeTree(dir, { "wrangler.jsonc": JSON.stringify({ name: "whatever", assets: { directory: "./public" } }), "public/index.html": "<h1>from action</h1>" });
  return dir;
};

test("Action で静的サイトを site のサイトにデプロイできる", async (t) => {
  const app = await start(t);
  await app.sites.ensure("docs");
  const result = await action(staticProject(t), { KANZUME_URL: app.base, KANZUME_TOKEN: app.token, KANZUME_SITE: "docs" });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /デプロイしました/);
  const page = await fetch(app.base, { headers: { "x-forwarded-host": "docs.localhost" } });
  assert.equal(await page.text(), "<h1>from action</h1>");
  assert.equal(app.sites.has("whatever"), false, "wrangler の name のサイトは作らない");
});

test("Action は .assetsignore に書いたファイルを送らず、シンボリックリンクは中身を送る", async (t) => {
  const app = await start(t);
  await app.sites.ensure("docs");
  const dir = tmpDir(t);
  writeTree(dir, {
    "wrangler.jsonc": JSON.stringify({ assets: { directory: "./dist" } }),
    "dist/index.html": "top",
    "dist/_worker.js/index.js": "secret server code",
    "dist/.assetsignore": "_worker.js\n",
    "brand/logo.txt": "logo",
  });
  fs.symlinkSync(path.join(dir, "brand", "logo.txt"), path.join(dir, "dist", "logo.txt"));
  const result = await action(dir, { KANZUME_URL: app.base, KANZUME_TOKEN: app.token, KANZUME_SITE: "docs" });
  assert.equal(result.code, 0, result.output);
  const get = (p: string) => fetch(`${app.base}${p}`, { headers: { "x-forwarded-host": "docs.localhost" } });
  assert.equal(await (await get("/")).text(), "top");
  assert.equal(await (await get("/logo.txt")).text(), "logo");
  assert.equal((await get("/_worker.js/index.js")).status, 404);
  assert.equal((await get("/.assetsignore")).status, 404);
});

test("Action は wrangler.toml のインラインテーブル（assets = { directory = ... }）も読む", async (t) => {
  const app = await start(t);
  await app.sites.ensure("docs");
  const dir = tmpDir(t);
  writeTree(dir, { "wrangler.toml": 'name = "x"\nassets = { binding = "ASSETS", directory = "./site" }\n', "site/index.html": "toml" });
  const result = await action(dir, { KANZUME_URL: app.base, KANZUME_TOKEN: app.token, KANZUME_SITE: "docs" });
  assert.equal(result.code, 0, result.output);
  assert.equal(await (await fetch(app.base, { headers: { "x-forwarded-host": "docs.localhost" } })).text(), "toml");
});

test("Action は Kanzume に届かないとき、分かるエラーで止まる", async (t) => {
  const result = await action(staticProject(t), { KANZUME_URL: "http://127.0.0.1:1", KANZUME_TOKEN: "x", KANZUME_SITE: "docs" });
  assert.notEqual(result.code, 0);
  assert.match(result.output, /Kanzume に送れませんでした/);
});

test("Action は site・トークン・サイトの有無を確かめて、分かるエラーで止まる", async (t) => {
  const app = await start(t);
  const dir = staticProject(t);
  const base = { KANZUME_URL: app.base, KANZUME_TOKEN: app.token };

  const noSite = await action(dir, base);
  assert.notEqual(noSite.code, 0);
  assert.match(noSite.output, /site を指定してください/);

  const missing = await action(dir, { ...base, KANZUME_SITE: "docs" });
  assert.notEqual(missing.code, 0);
  assert.match(missing.output, /サイト docs がありません/);

  await app.sites.ensure("docs");
  const badToken = await action(dir, { ...base, KANZUME_TOKEN: "wrong", KANZUME_SITE: "docs" });
  assert.notEqual(badToken.code, 0);
  assert.match(badToken.output, /Token が違います/);
});
