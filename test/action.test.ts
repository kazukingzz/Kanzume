import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { loadConfig } from "../src/config.ts";
import { createServer } from "../src/server.ts";
import { tmpDir, writeTree } from "./helpers.ts";

/** GitHub Actions 用の Action（action/deploy.mjs）を、そのまま動かして Kanzume にデプロイする */

const run = promisify(execFile);
const DEPLOY = path.join(import.meta.dirname, "..", "action", "deploy.mjs");

async function start(t: TestContext) {
  const app = await createServer(loadConfig({ KANZUME_DATA_DIR: tmpDir(t) }));
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    app.runtime.close();
    await new Promise((resolve) => app.server.close(resolve));
    await app.state.flush();
  });
  return { ...app, base: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}` };
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
  const result = await action(staticProject(t), { KANZUME_URL: app.base, KANZUME_TOKEN: app.state.deployToken, KANZUME_SITE: "docs" });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /デプロイしました/);
  const page = await fetch(app.base, { headers: { "x-forwarded-host": "docs.localhost" } });
  assert.equal(await page.text(), "<h1>from action</h1>");
  assert.equal(app.sites.has("whatever"), false, "wrangler の name のサイトは作らない");
});

test("Action は site・トークン・サイトの有無を確かめて、分かるエラーで止まる", async (t) => {
  const app = await start(t);
  const dir = staticProject(t);
  const base = { KANZUME_URL: app.base, KANZUME_TOKEN: app.state.deployToken };

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
