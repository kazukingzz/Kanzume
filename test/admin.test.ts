import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { Challenges } from "../src/admin/session.ts";
import { AdminState } from "../src/admin/state.ts";
import { EnvError, loadConfig } from "../src/config.ts";
import { createServer } from "../src/server.ts";
import { describeDevice, providerName } from "../src/admin/passkeys.ts";
import { tmpDir } from "./helpers.ts";

async function start(t: TestContext, dataDir = tmpDir(t)) {
  const app = await createServer(loadConfig({ KANZUME_DATA_DIR: dataDir, KANZUME_SETUP_TOKEN: "setup" }));
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    await app.state.flush();
  });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) =>
    fetch(`${base}/_admin/kanzume/api${path}`, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { ...app, base, post };
}

const fakeCredential = { id: "cred-1", publicKey: "AAAA", counter: 0, createdAt: new Date().toISOString() };

test("最初のパスキー登録はセットアップトークンでだけ始められる", async (t) => {
  const { post } = await start(t);
  assert.equal((await post("/register/options", { setupToken: "wrong" })).status, 403);
  assert.equal((await post("/register/options", { inviteToken: "kzi_x" })).status, 403);
  assert.equal((await post("/register/options", { setupToken: "setup" })).status, 200);
});

test("パスキー登録後は、新しいパスキーの登録には招待が必要で（チーム ID では登録できない）、サインインには不要", async (t) => {
  const { post, state } = await start(t);
  await state.addCredential(fakeCredential);

  assert.equal((await post("/register/options", { setupToken: "setup" })).status, 403);
  assert.equal((await post("/register/options", {})).status, 403);
  assert.equal((await post("/register/options", { teamId: "ABCDABCDABCDABCD" })).status, 403);
  const { token } = await state.createInvite("blog", state.setupUserId);
  const register = await post("/register/options", { inviteToken: token });
  assert.equal(register.status, 200);
  const options = (await register.json()) as { excludeCredentials: { id: string }[] };
  // 招待での登録は新しいユーザーになるので、既存のパスキーは除外しない
  assert.deepEqual(
    options.excludeCredentials.map((c) => c.id),
    [],
  );

  const login = await post("/login/options", {});
  assert.equal(login.status, 200);
  assert.deepEqual(
    ((await login.json()) as { allowCredentials: { id: string }[] }).allowCredentials.map((c) => c.id),
    ["cred-1"],
  );
});

test("管理 API はログインしないと見えない", async (t) => {
  const { base, post } = await start(t);
  assert.equal((await fetch(`${base}/_admin/kanzume/api/overview`)).status, 401);
  assert.equal((await fetch(`${base}/_admin/kanzume/api/sites/blog`)).status, 401);
  assert.equal((await post("/deploy-github", { url: "https://github.com/a/b" })).status, 401);
  assert.equal((await fetch(`${base}/_admin/kanzume/api/nothing`)).status, 404);
  const noOrigin = await fetch(`${base}/_admin/kanzume/api/tokens`, { method: "POST" });
  assert.equal(noOrigin.status, 403);
  assert.deepEqual(await (await fetch(`${base}/_admin/kanzume/api/state`)).json(), { registered: false, authenticated: false, domainFromEnv: false });
});

test("ログインのセッションはサーバーを再起動しても残り、ログアウトで消える", async (t) => {
  const dataDir = tmpDir(t);
  const before = new AdminState(dataDir);
  await before.init();
  const id = await before.createSession();
  const cookie = `kanzume_session=${id}`;

  const second = await start(t, dataDir);
  const state = await fetch(`${second.base}/_admin/kanzume/api/state`, { headers: { cookie } });
  assert.deepEqual(await state.json(), { registered: false, authenticated: true, domainFromEnv: false });
  assert.match(state.headers.get("set-cookie") ?? "", /Max-Age=34560000/);
  assert.equal((await fetch(`${second.base}/_admin/kanzume/api/overview`, { headers: { cookie } })).status, 200);
  const resources = await fetch(`${second.base}/_admin/kanzume/api/resources`, { headers: { cookie } });
  assert.equal(resources.status, 200);
  assert.ok(((await resources.json()) as { samples: unknown[] }).samples.length >= 1);
  assert.equal((await fetch(`${second.base}/_admin/kanzume/api/resources`)).status, 401);

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
  const { token } = await state.createInvite("blog", state.setupUserId);
  const attack = await post("/register/verify", { inviteToken: token, response: fakeRegistration(loginChallenge) });
  assert.equal(attack.status, 400);
  assert.match(((await attack.json()) as { error: string }).error, /challenge/i);
  assert.equal(state.credentials.length, 1);

  const { challenge: registerChallenge } = (await (await post("/register/options", { inviteToken: token })).json()) as { challenge: string };
  const legit = await post("/register/verify", { inviteToken: token, response: fakeRegistration(registerChallenge) });
  assert.equal((await post("/register/verify", { response: fakeRegistration(registerChallenge) })).status, 403, "招待なしでは登録まで進まない");
  assert.equal(legit.status, 400);
  assert.doesNotMatch(((await legit.json()) as { error: string }).error, /challenge/i);
});

test("同時にログインしても admin.json の保存が失敗しない", async (t) => {
  const dataDir = tmpDir(t);
  const state = new AdminState(dataDir);
  await state.init();
  const ids = await Promise.all(Array.from({ length: 20 }, () => state.createSession()));
  await Promise.all([state.setDomain("example.com"), state.removeSession(ids[0]), state.createSession()]);
  const reloaded = new AdminState(dataDir);
  await reloaded.init();
  assert.equal(reloaded.sessionCount, 20);
  assert.equal(reloaded.hasSession(ids[0]), false);
  assert.ok(ids.slice(1).every((id) => reloaded.hasSession(id)));
  assert.equal(reloaded.domain, "example.com");
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
  // 古い形式（数値）のセッションは、最初の管理者のセッションとして読み込まれる
  const saved = JSON.parse(fs.readFileSync(file, "utf8")).sessions as Record<string, { lastSeen: number; userId: string }>;
  assert.equal(Object.keys(saved).length, 1);
  assert.equal(Object.values(saved)[0].userId, reloaded.setupUserId);
  assert.ok(Date.now() - Object.values(saved)[0].lastSeen < 60_000, "使われたセッションの最終利用時刻が保存される");
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
  assert.deepEqual(await res.json(), { registered: false, authenticated: false, domainFromEnv: false });
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

test("同じ challenge で同時に検証しても、通るのは 1 つだけ（失敗したら押さえを外す）", () => {
  const challenges = new Challenges();
  const c = b64(challenges.create("login"));
  assert.equal(challenges.claim(c, "login"), true);
  assert.equal(challenges.claim(c, "login"), false, "検証中は 2 つ目を通さない");
  challenges.release(c);
  assert.equal(challenges.claim(c, "login"), true, "失敗したらもう一度使える");
  challenges.markUsed(c);
  assert.equal(challenges.claim(c, "login"), false);
});

test("ホスティングの URL があっても、独自ドメインから開けば Host と同じ Origin で管理画面の API を使える", async (t) => {
  const app = await createServer(
    loadConfig({ KANZUME_DATA_DIR: tmpDir(t), KANZUME_SETUP_TOKEN: "setup", RAILWAY_PUBLIC_DOMAIN: "kanzume-abcd.up.railway.app" }),
  );
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    await app.state.flush();
  });
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/_admin/kanzume/api/register/options`;
  const post = (origin: string) =>
    fetch(url, {
      method: "POST",
      headers: { origin, "x-forwarded-host": "tekitou.app", "x-forwarded-proto": "https", "content-type": "application/json" },
      body: JSON.stringify({ setupToken: "setup" }),
    });
  const ok = await post("https://tekitou.app");
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as { rp: { id: string } }).rp.id, "tekitou.app");
  assert.equal((await post("https://evil.example")).status, 403);
});

test("KANZUME_ORIGIN を設定したときはその Origin だけを受け付ける", () => {
  assert.equal(loadConfig({ KANZUME_ORIGIN: "https://tekitou.app/" }).origin, "https://tekitou.app");
  const railway = loadConfig({ RAILWAY_PUBLIC_DOMAIN: "kanzume-abcd.up.railway.app" });
  assert.equal(railway.origin, undefined);
  assert.equal(railway.publicUrl, "https://kanzume-abcd.up.railway.app", "起動ログに出すだけ");
});

test("数値の環境変数が数でない・範囲外なら、起動時に止める（上限が効かないまま動かさない）", () => {
  for (const env of [{ KANZUME_MAX_UPLOAD_MB: "50MB" }, { KANZUME_MAX_WORKERS: "0" }, { PORT: "abc" }, { KANZUME_CPU_TIMEOUT_MS: "-1" }]) {
    assert.throws(() => loadConfig(env), EnvError, JSON.stringify(env));
  }
  assert.equal(loadConfig({ KANZUME_MAX_UPLOAD_MB: "0.5" }).maxUploadBytes, 512 * 1024);
  assert.equal(loadConfig({ KANZUME_MAX_WORKERS: "" }).maxWorkers, 5);
});

test("パスキーの識別名を AAGUID と User-Agent から推測する", () => {
  assert.equal(providerName("EA9B8D66-4D01-1D21-3CE4-B6B48CB575D4"), "Google パスワード マネージャー");
  assert.equal(providerName("00000000-0000-0000-0000-000000000000"), undefined);
  const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  assert.equal(describeDevice(mac), "Mac・Chrome");
  assert.equal(describeDevice(`${mac} Edg/131.0.0.0`), "Mac・Edge");
  assert.equal(
    describeDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"),
    "iPhone・Safari",
  );
  assert.equal(describeDevice("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0"), "Windows・Firefox");
  assert.equal(describeDevice(undefined), undefined);
});

test("パスキーの一覧を取得し、名前を変更できる", async (t) => {
  const { base, state } = await start(t);
  await state.addCredential({ ...fakeCredential, name: "Mac・Chrome", device: "Mac・Chrome", aaguid: "ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4" });
  await state.addCredential({ ...fakeCredential, id: "cred-old" });
  const cookie = `kanzume_session=${await state.createSession()}`;
  const list = async () =>
    ((await (await fetch(`${base}/_admin/kanzume/api/passkeys`, { headers: { cookie } })).json()) as { passkeys: Record<string, unknown>[] }).passkeys;
  const rename = (body: unknown) =>
    fetch(`${base}/_admin/kanzume/api/passkeys/rename`, {
      method: "POST",
      headers: { cookie, origin: base, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const before = await list();
  assert.equal(before.length, 2);
  assert.deepEqual(
    { name: before[0].name, provider: before[0].provider, device: before[0].device },
    { name: "Mac・Chrome", provider: "Google パスワード マネージャー", device: "Mac・Chrome" },
  );
  assert.deepEqual({ name: before[1].name, provider: before[1].provider }, { name: "", provider: null });

  assert.equal((await rename({ id: "cred-1", name: "  仕事用の MacBook\n" })).status, 200);
  assert.equal((await list())[0].name, "仕事用の MacBook");
  assert.equal((await rename({ id: "cred-1", name: "  " })).status, 400);
  assert.equal((await rename({ id: "nope", name: "x" })).status, 404);
  assert.equal((await fetch(`${base}/_admin/kanzume/api/passkeys`)).status, 401);
});
