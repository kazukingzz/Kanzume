import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { checkSiteSession, createSiteSession, parseSiteAccess, safeNext, SITE_SESSION_MAX_AGE } from "../src/site-auth.ts";
import { type App, startApp } from "./fixtures.ts";
import { tarGz } from "./helpers.ts";
import { SoftAuthenticator } from "./webauthn.ts";

const access = { secret: "s", passkeys: [{ id: "cred", publicKey: "AAAA", counter: 0, createdAt: "", name: "" }] };

test("ログインの Cookie は、署名・サイト・期限・登録済みのパスキーがすべて合うときだけ通る", () => {
  const now = Date.now();
  const token = createSiteSession(access, "blog", "cred", now);
  assert.equal(checkSiteSession(access, "blog", token, now + 1000), true);
  assert.equal(checkSiteSession(access, "shop", token, now), false, "別のサイトの Cookie は使えない");
  assert.equal(checkSiteSession({ ...access, secret: "other" }, "blog", token, now), false, "ログインをやめて鍵が変わったら使えない");
  assert.equal(checkSiteSession({ ...access, passkeys: [] }, "blog", token, now), false, "パスキーを消したら使えない");
  assert.equal(checkSiteSession(access, "blog", token, now + SITE_SESSION_MAX_AGE * 1000 + 1), false, "30 日を過ぎたら使えない");
  assert.equal(checkSiteSession(access, "blog", `${token.slice(0, -1)}A`, now), false);
  assert.equal(checkSiteSession(access, "blog", token.replace(String(now), String(now + 1)), now + 1), false, "発行時刻を書き換えられない");
});

test("settings.json のログインの設定が壊れていても、誰でも開ける状態にはしない", () => {
  assert.equal(parseSiteAccess(undefined), undefined);
  const broken = parseSiteAccess({ passkeys: [{ id: 1 }] });
  assert.deepEqual(broken?.passkeys, [], "読めないパスキーは使わず、誰もログインできない状態にする");
  assert.ok(broken?.secret);
});

test("ログインのあとに戻る先は、同じサイトのパスだけ", () => {
  assert.equal(safeNext("/a?b=c"), "/a?b=c");
  for (const bad of ["//evil.example", "/\\evil.example", "https://evil.example", "", null]) assert.equal(safeNext(bad), "/", String(bad));
});

const ROOT = "example.test";

async function setup(t: TestContext) {
  const app = await startApp(t);
  await app.state.setDomain(ROOT);
  const cookie = await app.adminCookie();
  // 管理画面は host（既定はルートドメイン）で開いている
  const admin = (p: string, method = "GET", body?: unknown, host = ROOT) =>
    fetch(`${app.base}/_admin/kanzume/api${p}`, {
      method,
      headers: { cookie, origin: `http://${host}`, "x-forwarded-host": host, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const site = (host: string, p = "/", init: RequestInit = {}) => app.site(host, p, init);
  for (const name of ["home", "blog"]) {
    const res = await app.deploy(tarGz(t, { "wrangler.json": JSON.stringify({ name, assets: {} }), "assets/index.html": `<p>${name}</p>` }), {
      site: name,
    });
    assert.equal(res.status, 200);
  }
  return { app, admin, site };
}

/** 管理画面でサイトのパスキーを登録する */
async function register(admin: Awaited<ReturnType<typeof setup>>["admin"], key: SoftAuthenticator, host = ROOT, name = "blog") {
  const options = await admin(`/sites/${name}/access/register/options`, "POST", {}, host);
  if (options.status !== 200) return options;
  return admin(`/sites/${name}/access/register/verify`, "POST", { response: key.create(await options.json(), `http://${host}`) }, host);
}

/** サイトでパスキーでログインする */
async function login(app: App, key: SoftAuthenticator, host = `blog.${ROOT}`) {
  const post = (p: string, body: unknown) =>
    app.site(host, `/_kanzume/login${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const options = await (await post("/options", {})).json();
  return post("/verify", { response: key.get(options, `http://${host}`), next: "/docs?x=1" });
}

const accessOf = async (admin: Awaited<ReturnType<typeof setup>>["admin"]) =>
  (await (await admin("/sites/blog/access")).json()) as { enabled: boolean; passkeys: { id: string }[] };

test("パスキーを登録するとログインが必須になり、そのパスキーでログインした人だけがサイトを開ける", async (t) => {
  const { app, admin, site } = await setup(t);
  assert.deepEqual(await accessOf(admin), { enabled: false, passkeys: [] });

  const key = new SoftAuthenticator();
  assert.equal((await register(admin, key)).status, 200);
  assert.deepEqual(
    (await accessOf(admin)).passkeys.map((p) => p.id),
    [key.credentialId],
  );

  const page = await site(`blog.${ROOT}`, "/docs?q=1", { headers: { accept: "text/html" } });
  assert.equal(page.status, 302, "ページを開くとログイン画面へ");
  assert.equal(page.headers.get("location"), "/_kanzume/login?next=%2Fdocs%3Fq%3D1");
  assert.equal((await site(`blog.${ROOT}`, "/api")).status, 401, "ページ以外（fetch など）は 401");
  const loginPage = await site(`blog.${ROOT}`, "/_kanzume/login");
  assert.equal(loginPage.status, 200);
  assert.match(await loginPage.text(), /パスキーでログイン/);
  assert.equal(await (await site(ROOT, "/")).text(), "<p>home</p>", "ほかのサイトはそのまま開ける");

  const res = await login(app, key);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, next: "/docs?x=1" });
  const cookie = res.headers.get("set-cookie")!;
  assert.match(cookie, /^kanzume_site_session=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/);
  const session = cookie.split(";")[0];
  assert.equal(await (await site(`blog.${ROOT}`, "/", { headers: { cookie: session } })).text(), "<p>blog</p>");
  assert.equal(
    await (await site(`blog.${ROOT}`, "/", { headers: { cookie: `kanzume_site_session=forged; ${session}` } })).text(),
    "<p>blog</p>",
    "親ドメインに付けられた同名の Cookie があっても通る",
  );

  const other = new SoftAuthenticator();
  const options = await (await site(`blog.${ROOT}`, "/_kanzume/login/options", { method: "POST" })).json();
  const rejected = await site(`blog.${ROOT}`, "/_kanzume/login/verify", {
    method: "POST",
    body: JSON.stringify({ response: other.get(options, `http://blog.${ROOT}`) }),
  });
  assert.equal(rejected.status, 400, "登録していないパスキーではログインできない");
  assert.equal(rejected.headers.get("set-cookie"), null);
});

test("パスキーを登録できなければ、ログインは必須にならない", async (t) => {
  const { admin, site } = await setup(t);
  const options = await (await admin("/sites/blog/access/register/options", "POST", {})).json();
  const broken = new SoftAuthenticator().create(options, "http://evil.example");
  assert.equal((await admin("/sites/blog/access/register/verify", "POST", { response: broken })).status, 400);
  assert.deepEqual(await accessOf(admin), { enabled: false, passkeys: [] });

  // ルートドメインの外のホストで開いた管理画面では、ルートドメインのパスキーを作れない
  const outside = await register(admin, new SoftAuthenticator(), "kanzume.up.railway.app");
  assert.equal(outside.status, 400);
  assert.match(((await outside.json()) as { error: string }).error, /example\.test/);
  assert.equal((await accessOf(admin)).enabled, false);
  assert.equal((await site(`blog.${ROOT}`, "/")).status, 200);
});

test("パスキーを追加・削除でき、最後の 1 つは消せない。オフにするとパスキーとログイン中の Cookie が使えなくなる", async (t) => {
  const { app, admin, site } = await setup(t);
  const first = new SoftAuthenticator();
  const second = new SoftAuthenticator();
  assert.equal((await register(admin, first)).status, 200);
  assert.equal((await register(admin, second)).status, 200);
  assert.equal((await accessOf(admin)).passkeys.length, 2);

  const session = (await login(app, first)).headers.get("set-cookie")!.split(";")[0];
  assert.equal((await admin(`/sites/blog/access/passkeys/${first.credentialId}`, "DELETE")).status, 200);
  assert.equal((await site(`blog.${ROOT}`, "/", { headers: { cookie: session } })).status, 401, "消したパスキーでのログインは使えない");
  assert.equal((await login(app, first)).status, 400);
  assert.equal((await login(app, second)).status, 200);
  assert.equal((await admin(`/sites/blog/access/passkeys/${second.credentialId}`, "DELETE")).status, 400, "最後の 1 つは消せない");

  const kept = (await login(app, second)).headers.get("set-cookie")!.split(";")[0];
  assert.equal((await admin("/sites/blog/access", "DELETE")).status, 200);
  assert.deepEqual(await accessOf(admin), { enabled: false, passkeys: [] });
  assert.equal(await (await site(`blog.${ROOT}`, "/")).text(), "<p>blog</p>", "オフにすると誰でも開ける");

  assert.equal((await register(admin, second)).status, 200);
  assert.equal((await site(`blog.${ROOT}`, "/", { headers: { cookie: kept } })).status, 401, "オンにし直すと、前のログインは使えない");
});

test("ルートドメインのサイトもログインを必須にでき、管理画面はそのまま開ける", async (t) => {
  const { app, admin, site } = await setup(t);
  const key = new SoftAuthenticator();
  assert.equal((await register(admin, key, ROOT, "home")).status, 200);
  assert.equal((await site(ROOT, "/")).status, 401);
  assert.equal((await site(ROOT, "/_admin/kanzume/")).status, 200, "管理画面はログインの対象外");
  assert.equal((await admin("/overview")).status, 200);
  const session = (await login(app, key, ROOT)).headers.get("set-cookie")!.split(";")[0];
  assert.equal(await (await site(ROOT, "/", { headers: { cookie: session } })).text(), "<p>home</p>");
  assert.equal((await site(`blog.${ROOT}`, "/", { headers: { cookie: session } })).status, 200, "ほかのサイトには影響しない");
});

test("サイトのパスキーは、そのサイトを扱えるユーザーだけが変えられる", async (t) => {
  const { app } = await setup(t);
  const member = await app.state.createUser("参加者", "member", ["home"]);
  const api = app.api(`kanzume_session=${await app.state.createSession(member.id)}`);
  assert.equal((await api("/sites/blog/access")).status, 403);
  assert.equal((await api("/sites/blog/access/register/options", "POST", {})).status, 403);
  assert.equal((await api("/sites/blog/access", "DELETE")).status, 403);
});
