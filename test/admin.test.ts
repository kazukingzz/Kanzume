import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { AdminState, normalizeTeamId } from "../src/admin/state.ts";
import { closeSiteDb } from "../src/bindings/db.ts";
import { loadConfig } from "../src/config.ts";
import { createServer } from "../src/server.ts";
import { tmpDir } from "./helpers.ts";

async function start(t: TestContext, dataDir = tmpDir(t)) {
  const app = await createServer(loadConfig({ KANZUME_DATA_DIR: dataDir, KANZUME_SETUP_TOKEN: "setup" }));
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    closeSiteDb(app.store.siteDir);
  });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) =>
    fetch(`${base}/_admin/kanzume/api${path}`, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { ...app, base, post };
}

const fakeCredential = { id: "cred-1", publicKey: "AAAA", counter: 0, createdAt: new Date().toISOString() };

test("チーム ID は紛らわしい文字を含まない 16 文字で、再起動しても変わらない", async (t) => {
  const dir = tmpDir(t);
  const state = new AdminState(dir);
  await state.init();
  assert.match(state.teamId, /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
  const again = new AdminState(dir);
  await again.init();
  assert.equal(again.teamId, state.teamId);
});

test("チーム ID は大文字小文字・ハイフン・空白・O と 0・I/L と 1 の違いを吸収して照合する", async (t) => {
  const state = new AdminState(tmpDir(t));
  await state.init();
  const id = state.teamId;
  assert.equal(state.checkTeamId(id), true);
  assert.equal(state.checkTeamId(id.replace(/-/g, "").toLowerCase()), true);
  assert.equal(state.checkTeamId(` ${id.replace(/-/g, " ")} `), true);
  assert.equal(state.checkTeamId(id.replace(/0/g, "O")), true);
  assert.equal(state.checkTeamId(id.slice(0, -1)), false);
  assert.equal(state.checkTeamId(""), false);
  assert.equal(normalizeTeamId("abcd-efgh-ijkl-mnop"), "ABCDEFGH1JK1MN0P");
});

test("最初のパスキー登録はセットアップトークンでだけ始められる", async (t) => {
  const { post, state } = await start(t);
  assert.equal((await post("/register/options", { setupToken: "wrong" })).status, 403);
  assert.equal((await post("/register/options", { teamId: state.teamId })).status, 403);
  assert.equal((await post("/register/options", { setupToken: "setup" })).status, 200);
});

test("パスキー登録後は、チーム ID がないと登録もログインも始められない", async (t) => {
  const { post, state } = await start(t);
  await state.addCredential(fakeCredential);

  assert.equal((await post("/register/options", { setupToken: "setup" })).status, 403);
  assert.equal((await post("/register/options", {})).status, 403);
  assert.equal((await post("/register/options", { teamId: "0000-0000-0000-0000" })).status, 403);
  const register = await post("/register/options", { teamId: state.teamId.toLowerCase() });
  assert.equal(register.status, 200);
  const options = (await register.json()) as { excludeCredentials: { id: string }[] };
  assert.deepEqual(options.excludeCredentials.map((c) => c.id), ["cred-1"]);

  assert.equal((await post("/login/options", {})).status, 403);
  assert.equal((await post("/login/options", { teamId: "0000-0000-0000-0000" })).status, 403);
  assert.equal((await post("/login/options", { teamId: state.teamId })).status, 200);
});

test("チーム ID や管理 API はログインしないと見えない", async (t) => {
  const { base, post } = await start(t);
  assert.equal((await fetch(`${base}/_admin/kanzume/api/overview`)).status, 401);
  assert.equal((await fetch(`${base}/_admin/kanzume/api/site`)).status, 401);
  assert.equal((await post("/site/deploy-github", { url: "https://github.com/a/b" })).status, 401);
  const noOrigin = await fetch(`${base}/_admin/kanzume/api/token/rotate`, { method: "POST" });
  assert.equal(noOrigin.status, 403);
  assert.deepEqual(await (await fetch(`${base}/_admin/kanzume/api/state`)).json(), { registered: false, authenticated: false });
});
