import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { Challenges } from "../src/admin/session.ts";
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
    await app.state.flush();
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

test("パスキー登録後は、新しいパスキーの登録にはチーム ID が必要で、サインインには不要", async (t) => {
  const { post, state } = await start(t);
  await state.addCredential(fakeCredential);

  assert.equal((await post("/register/options", { setupToken: "setup" })).status, 403);
  assert.equal((await post("/register/options", {})).status, 403);
  assert.equal((await post("/register/options", { teamId: "0000-0000-0000-0000" })).status, 403);
  const register = await post("/register/options", { teamId: state.teamId.toLowerCase() });
  assert.equal(register.status, 200);
  const options = (await register.json()) as { excludeCredentials: { id: string }[] };
  assert.deepEqual(options.excludeCredentials.map((c) => c.id), ["cred-1"]);

  const login = await post("/login/options", {});
  assert.equal(login.status, 200);
  assert.deepEqual(((await login.json()) as { allowCredentials: { id: string }[] }).allowCredentials.map((c) => c.id), ["cred-1"]);
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

test("ログインのセッションはサーバーを再起動しても残り、ログアウトで消える", async (t) => {
  const dataDir = tmpDir(t);
  const before = new AdminState(dataDir);
  await before.init();
  const id = await before.createSession();
  const cookie = `kanzume_session=${id}`;

  const second = await start(t, dataDir);
  const state = await fetch(`${second.base}/_admin/kanzume/api/state`, { headers: { cookie } });
  assert.deepEqual(await state.json(), { registered: false, authenticated: true });
  assert.match(state.headers.get("set-cookie") ?? "", /Max-Age=34560000/);
  assert.equal((await fetch(`${second.base}/_admin/kanzume/api/overview`, { headers: { cookie } })).status, 200);

  const logout = await fetch(`${second.base}/_admin/kanzume/api/logout`, { method: "POST", headers: { cookie, origin: second.base } });
  assert.equal(logout.status, 200);
  assert.equal((await fetch(`${second.base}/_admin/kanzume/api/overview`, { headers: { cookie } })).status, 401);
  const reloaded = new AdminState(dataDir);
  await reloaded.init();
  assert.equal(reloaded.hasSession(id), false, "ログアウトがディスクにも反映されている");
});

test("認証なしで出せるログイン用の challenge では、新しいパスキーを登録できない", async (t) => {
  const { post, state, base } = await start(t);
  await state.addCredential(fakeCredential);
  const fakeRegistration = (challenge: string) => ({
    id: "attacker",
    rawId: "attacker",
    type: "public-key",
    clientExtensionResults: {},
    response: {
      clientDataJSON: Buffer.from(JSON.stringify({ type: "webauthn.create", challenge, origin: base })).toString("base64url"),
      attestationObject: Buffer.from("x").toString("base64url"),
    },
  });

  const { challenge: loginChallenge } = (await (await post("/login/options", {})).json()) as { challenge: string };
  const attack = await post("/register/verify", { response: fakeRegistration(loginChallenge) });
  assert.equal(attack.status, 400);
  assert.match(((await attack.json()) as { error: string }).error, /challenge/i);
  assert.equal(state.credentials.length, 1);

  const { challenge: registerChallenge } = (await (await post("/register/options", { teamId: state.teamId })).json()) as { challenge: string };
  const legit = await post("/register/verify", { response: fakeRegistration(registerChallenge) });
  assert.equal(legit.status, 400);
  assert.doesNotMatch(((await legit.json()) as { error: string }).error, /challenge/i);
});

test("同時にログインしても admin.json の保存が失敗しない", async (t) => {
  const dataDir = tmpDir(t);
  const state = new AdminState(dataDir);
  await state.init();
  const ids = await Promise.all(Array.from({ length: 20 }, () => state.createSession()));
  await Promise.all([state.rotateDeployToken(), state.removeSession(ids[0]), state.createSession()]);
  const reloaded = new AdminState(dataDir);
  await reloaded.init();
  assert.equal(reloaded.sessionCount, 20);
  assert.equal(reloaded.hasSession(ids[0]), false);
  assert.ok(ids.slice(1).every((id) => reloaded.hasSession(id)));
  assert.equal(reloaded.deployToken, state.deployToken);
});

test("400 日使われていないセッションは消え、使われているセッションは残る", async (t) => {
  const dataDir = tmpDir(t);
  const state = new AdminState(dataDir);
  await state.init();
  const old = await state.createSession();
  const used = await state.createSession();
  const file = path.join(dataDir, "admin.json");
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  const hashes = Object.keys(json.sessions);
  json.sessions[hashes[0]] = Date.now() - 401 * 24 * 60 * 60 * 1000;
  json.sessions[hashes[1]] = Date.now() - 399 * 24 * 60 * 60 * 1000;
  fs.writeFileSync(file, JSON.stringify(json));

  const reloaded = new AdminState(dataDir);
  await reloaded.init();
  assert.equal(reloaded.hasSession(old), false);
  assert.equal(reloaded.hasSession(used), true);
  await reloaded.flush();
  const saved = JSON.parse(fs.readFileSync(file, "utf8")).sessions as Record<string, number>;
  assert.equal(Object.keys(saved).length, 1);
  assert.ok(Date.now() - Object.values(saved)[0] < 60_000, "使われたセッションの最終利用時刻が保存される");
});

test("リクエストのたびに admin.json を書き直さない", async (t) => {
  const dataDir = tmpDir(t);
  const state = new AdminState(dataDir);
  await state.init();
  const id = await state.createSession();
  const file = path.join(dataDir, "admin.json");
  const before = fs.statSync(file).mtimeMs;
  for (let i = 0; i < 50; i++) assert.equal(state.hasSession(id), true);
  await state.flush();
  assert.equal(fs.statSync(file).mtimeMs, before);
});

test("前のバージョンが残した一時ファイルは起動時に消し、読めない admin.json は初期化せずに起動を止める", async (t) => {
  const dataDir = tmpDir(t);
  const state = new AdminState(dataDir);
  await state.init();
  const leftover = path.join(dataDir, "admin.json.123.4.tmp");
  fs.writeFileSync(leftover, "secret");
  const again = new AdminState(dataDir);
  await again.init();
  assert.equal(fs.existsSync(leftover), false);

  fs.writeFileSync(path.join(dataDir, "admin.json"), "{ broken");
  await assert.rejects(new AdminState(dataDir).init());
  assert.equal(fs.readFileSync(path.join(dataDir, "admin.json"), "utf8"), "{ broken");
});

test("壊れた Cookie があっても管理 API は 500 にならない", async (t) => {
  const { base } = await start(t);
  const res = await fetch(`${base}/_admin/kanzume/api/state`, { headers: { cookie: "kanzume_session=%E0" } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { registered: false, authenticated: false });
});

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

test("challenge はいくら発行されても溜まらず、正規ユーザーの challenge が追い出されない", () => {
  const challenges = new Challenges();
  const mine = b64(challenges.create("register"));
  for (let i = 0; i < 5000; i++) challenges.create("login");
  assert.equal(challenges.check(mine, "register"), true);
});

test("challenge は署名・用途・期限・使用済みを確かめる", () => {
  const challenges = new Challenges();
  const now = Date.now();
  const c = b64(challenges.create("login", now));
  assert.equal(challenges.check(c, "login", now), true);
  assert.equal(challenges.check(c, "register", now), false, "用途が違えば受け付けない");
  assert.equal(challenges.check(c, "login", now + 6 * 60_000), false, "5 分を過ぎたら受け付けない");
  assert.equal(new Challenges().check(c, "login", now), false, "別の鍵で署名したものは受け付けない");
  const tampered = Buffer.from(c, "base64url");
  tampered[0] ^= 1;
  assert.equal(challenges.check(tampered.toString("base64url"), "login", now), false, "書き換えたら受け付けない");
  assert.equal(challenges.check("short", "login", now), false);
  challenges.markUsed(c, now);
  assert.equal(challenges.check(c, "login", now), false, "一度使ったものは受け付けない");
});
