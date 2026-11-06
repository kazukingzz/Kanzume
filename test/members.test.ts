import assert from "node:assert/strict";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { test, type TestContext } from "node:test";
import { AdminState } from "../src/admin/state.ts";
import { loadConfig } from "../src/config.ts";
import { DeployLog } from "../src/deploy/deployer.ts";
import { deployFromFiles } from "../src/deploy/github.ts";
import { createServer } from "../src/server.ts";
import { rawTar, rawTarEntry, tmpDir } from "./helpers.ts";

const cred = (id: string, userId?: string) => ({ id, publicKey: "AAAA", counter: 0, createdAt: new Date().toISOString(), userId });

async function start(t: TestContext) {
  const app = await createServer(loadConfig({ KANZUME_DATA_DIR: tmpDir(t), KANZUME_SETUP_TOKEN: "setup" }));
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    await app.state.flush();
  });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const as = (cookie: string | null) => (p: string, method = "GET", body?: unknown) =>
    fetch(`${base}/_admin/kanzume/api${p}`, {
      method,
      headers: { ...(cookie ? { cookie } : {}), origin: base, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const deploy = async (name: string) => {
    const result = await deployFromFiles(
      [
        { path: "wrangler.jsonc", data: Buffer.from(JSON.stringify({ name, main: "index.js", compatibility_date: "2026-10-01" })) },
        { path: "index.js", data: Buffer.from(`export default { fetch() { return new Response(${JSON.stringify(name)}); } };`) },
      ],
      app.deployer,
      { source: {}, log: new DeployLog("test"), buildLog: [], autoRoot: true },
    );
    assert.equal(result.ok, true, result.ok ? "" : result.error);
  };
  await app.state.addCredential(cred("admin-cred"));
  const admin = as(`kanzume_session=${await app.state.createSession()}`);
  return { ...app, base, as, admin, deploy };
}

async function member(app: Awaited<ReturnType<typeof start>>, sites: string[]) {
  const user = await app.state.createUser("参加者", "member", sites);
  await app.state.addCredential(cred(`cred-${user.id}`, user.id));
  return { user, api: app.as(`kanzume_session=${await app.state.createSession(user.id)}`) };
}

test("ユーザーのない admin.json は、既存のパスキーとセッションを最初の管理者のものとして読み込む", async (t) => {
  const dir = tmpDir(t);
  fs.writeFileSync(
    path.join(dir, "admin.json"),
    JSON.stringify({ userId: "legacy", teamId: "ABCDABCDABCDABCD", deployToken: "kz_x", credentials: [cred("old")], sessions: { abc: Date.now() } }),
  );
  const state = new AdminState(dir);
  await state.init();
  assert.deepEqual(state.users.map((u) => [u.id, u.role]), [["legacy", "admin"]]);
  assert.equal(state.credentialsOf("legacy").length, 1);
  assert.equal(state.sessionCount, 1);
  await state.flush();
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "admin.json"), "utf8"));
  assert.equal(saved.credentials[0].userId, "legacy");
  assert.deepEqual(Object.values(saved.sessions)[0], { lastSeen: (Object.values(saved.sessions)[0] as { lastSeen: number }).lastSeen, userId: "legacy" });
});

test("招待リンクは 1 回だけ使え、期限切れ・取り消し済みは使えない。ログイン中に使うとサイトが増える", async (t) => {
  const app = await start(t);
  await app.deploy("blog");
  await app.deploy("shop");

  const created = await app.admin("/sites/blog/invites", "POST", {});
  assert.equal(created.status, 200);
  const { url } = (await created.json()) as { url: string };
  const token = url.split("#/invite/")[1];
  assert.match(token, /^kzi_/);
  assert.deepEqual(await (await app.as(null)(`/invite?token=${token}`)).json(), { valid: true, site: "blog", expiresAt: app.state.checkInvite(token)!.expiresAt });
  // パスキーの登録画面は招待で開ける（チーム ID なし）
  assert.equal((await app.as(null)("/register/options", "POST", { inviteToken: token, name: "太郎" })).status, 200);
  assert.equal((await app.as(null)("/register/options", "POST", { inviteToken: "kzi_nope" })).status, 403);

  // 招待を使うと、そのサイトだけのメンバーになる。2 回目は使えない
  const taro = await app.state.redeemInviteAsNewUser(token, "太郎");
  assert.deepEqual({ name: taro?.name, role: taro?.role, sites: taro?.sites }, { name: "太郎", role: "member", sites: ["blog"] });
  assert.equal(await app.state.redeemInviteAsNewUser(token, "次郎"), null);
  assert.deepEqual(await (await app.as(null)(`/invite?token=${token}`)).json(), { valid: false });
  assert.equal((await app.as(null)("/register/options", "POST", { inviteToken: token })).status, 403);

  // ログイン中のメンバーが別のサイトの招待を受ける
  const second = ((await (await app.admin("/sites/shop/invites", "POST", {})).json()) as { url: string }).url.split("#/invite/")[1];
  const api = app.as(`kanzume_session=${await app.state.createSession(taro!.id)}`);
  assert.deepEqual(await (await api("/invite/accept", "POST", { token: second })).json(), { site: "shop" });
  assert.deepEqual(app.state.user(taro!.id)!.sites, ["blog", "shop"]);
  assert.equal((await api("/invite/accept", "POST", { token: second })).status, 400);

  // 取り消しと期限切れ
  const third = (await (await app.admin("/sites/blog/invites", "POST", {})).json()) as { id: string; url: string };
  const members = (await (await app.admin("/sites/blog/members")).json()) as { members: { name: string }[]; invites: { id: string }[] };
  assert.deepEqual(members.members.map((m) => m.name), ["太郎"]);
  assert.deepEqual(members.invites.map((i) => i.id), [third.id]);
  assert.equal((await app.admin(`/sites/blog/invites/${third.id}`, "DELETE")).status, 200);
  assert.equal(app.state.checkInvite(third.url.split("#/invite/")[1]), null);
  const { token: expired, invite } = await app.state.createInvite("blog", "x");
  invite.expiresAt = new Date(Date.now() - 1000).toISOString();
  assert.equal(app.state.checkInvite(expired), null);

  // メンバーは招待を作れない
  assert.equal((await api("/sites/blog/invites", "POST", {})).status, 403);
});

test("メンバーは自分のサイトだけを見て操作でき、全体の設定やほかのサイトには触れない", async (t) => {
  const app = await start(t);
  await app.deploy("blog");
  await app.deploy("shop");
  await app.repos.create("blog");
  await app.repos.create("shop");
  const { user, api } = await member(app, ["blog"]);

  const overview = (await (await api("/overview")).json()) as Record<string, unknown>;
  assert.deepEqual(overview.me, { id: user.id, name: "参加者", role: "member", sites: ["blog"] });
  assert.equal(overview.token, undefined);
  assert.equal(overview.teamId, undefined);
  assert.deepEqual(((await (await api("/sites")).json()) as { sites: { name: string }[] }).sites.map((s) => s.name), ["blog"]);
  assert.deepEqual(((await (await api("/repos")).json()) as { repos: { name: string }[] }).repos.map((r) => r.name), ["blog"]);

  // 自分のサイト
  assert.equal((await api("/sites/blog")).status, 200);
  assert.equal((await api("/sites/blog/deployments")).status, 200);
  assert.equal((await api("/sites/blog/settings", "PUT", { vars: { A: "1" } })).status, 200);
  assert.equal((await api("/repos/blog")).status, 200);
  assert.equal((await api("/tokens", "POST", { name: "PC", ttl: null })).status, 200);

  // ほかのサイト・全体の設定
  for (const [p, method] of [
    ["/sites/shop", "GET"],
    ["/sites/shop/settings", "PUT"],
    ["/sites/shop", "DELETE"],
    ["/repos/shop", "GET"],
    ["/repos", "POST"],
    ["/sites/blog/members", "GET"],
    ["/domain", "POST"],
    ["/backup", "GET"],
    ["/token/rotate", "POST"],
    ["/resources", "GET"],
    ["/root-site", "POST"],
    ["/users", "GET"],
    [`/users/${user.id}`, "PUT"],
  ] as const) {
    assert.equal((await api(p, method, method === "GET" ? undefined : { name: "shop" })).status, 403, `${method} ${p}`);
  }
  // 新しいサイトは作れず、ほかのサイトも再デプロイできない（GitHub からの取得より前に断る）
  assert.equal((await api("/deploy-github", "POST", { url: "https://github.com/a/b", name: "new-site" })).status, 403);
  assert.equal((await api("/deploy-github", "POST", { url: "https://github.com/a/b", name: "shop" })).status, 403);
  assert.equal((await api("/deploy-github", "POST", { url: "https://github.com/a/b" })).status, 403);

  // 自分のパスキーだけが見える
  const passkeys = (await (await api("/passkeys")).json()) as { passkeys: { id: string }[] };
  assert.deepEqual(passkeys.passkeys.map((p) => p.id), [`cred-${user.id}`]);
  assert.equal((await api("/passkeys/rename", "POST", { id: "admin-cred", name: "x" })).status, 404);
  assert.equal((await api(`/passkeys/cred-${user.id}`, "DELETE")).status, 400, "最後のパスキーは消せない");
  assert.equal((await api("/me", "PUT", { name: "  花子 " })).status, 200);
  assert.equal(app.state.user(user.id)!.name, "花子");

  // サイトを消すと、メンバーの参加先からも消える
  assert.equal((await api("/sites/blog", "DELETE")).status, 200);
  assert.deepEqual(app.state.user(user.id)!.sites, []);
});

test("管理者はメンバーのロールを変え、サイトから外し、削除できる。最後の管理者は守る", async (t) => {
  const app = await start(t);
  await app.deploy("blog");
  const { user, api } = await member(app, ["blog"]);

  const users = (await (await app.admin("/users")).json()) as { users: { id: string; role: string; passkeys: number; me: boolean }[] };
  assert.deepEqual(users.users.map((u) => [u.role, u.passkeys, u.me]), [["admin", 1, true], ["member", 1, false]]);
  const adminId = users.users[0].id;
  assert.equal((await app.admin(`/users/${adminId}`, "PUT", { role: "member" })).status, 400, "最後の管理者は降格できない");
  assert.equal((await app.admin(`/users/${adminId}`, "DELETE")).status, 400, "自分は削除できない");

  assert.equal((await app.admin(`/sites/blog/members/${user.id}`, "DELETE")).status, 200);
  assert.equal((await api("/sites/blog")).status, 403);
  assert.equal((await app.admin(`/users/${user.id}`, "PUT", { role: "admin" })).status, 200);
  assert.equal((await api("/users")).status, 200, "管理者になると全体を扱える");
  assert.equal((await app.admin(`/users/${user.id}`, "DELETE")).status, 200);
  assert.equal((await api("/overview")).status, 401, "削除したユーザーのセッションは使えない");
  assert.equal(app.state.credentialsOf(user.id).length, 0);
});

test("メンバーの個人トークンは、参加しているサイトへの /_api/deploy だけに使える", async (t) => {
  const app = await start(t);
  await app.deploy("blog");
  const { api } = await member(app, ["blog"]);
  const { token } = (await (await api("/tokens", "POST", { name: "Actions", ttl: null })).json()) as { token: string };
  assert.match(token, /^kzu_/);
  const upload = (name: string) =>
    fetch(`${app.base}/_api/deploy`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: gzipSync(
        rawTar([
          rawTarEntry("wrangler.jsonc", Buffer.from(JSON.stringify({ name, compatibility_date: "2026-10-01", assets: { directory: "public" } }))),
          rawTarEntry("assets/index.html", Buffer.from(name)),
        ]),
      ),
    });
  const ok = await upload("blog");
  assert.equal(ok.status, 200, await ok.clone().text());
  const other = await upload("shop");
  assert.equal(other.status, 400);
  assert.match(((await other.json()) as { error: string }).error, /参加しているサイト（blog）にしかデプロイできません/);
  assert.equal(app.sites.has("shop"), false);
  assert.ok(app.history.list().every((d) => d.name !== "shop"), "ほかのサイトの履歴にも残さない");
  // 消されたユーザーのトークンは使えない
  await app.state.removeUser(app.state.users.find((u) => u.role === "member")!.id);
  assert.equal((await upload("blog")).status, 401);
});

test("サイトを先に作り（未デプロイ）、デプロイ前でも設定・トークン・リポジトリを扱える", async (t) => {
  const app = await start(t);
  const created = await app.admin("/sites", "POST", { name: "Blog " });
  assert.equal(created.status, 200, await created.clone().text());
  assert.equal(((await created.json()) as { name: string }).name, "blog");
  assert.equal((await app.admin("/sites", "POST", { name: "blog" })).status, 409);
  assert.equal((await app.admin("/sites", "POST", { name: "bad name" })).status, 400);
  await app.admin("/sites/blog/settings", "PUT", { subdomain: "news" });
  assert.equal((await app.admin("/sites", "POST", { name: "news" })).status, 400, "ほかのサイトのサブドメインとは重ねない");

  const list = (await (await app.admin("/sites")).json()) as { sites: { name: string; deployed: boolean; deployedAt: string | null }[] };
  assert.deepEqual(list.sites.map((s) => [s.name, s.deployed, s.deployedAt]), [["blog", false, null]]);
  const detail = (await (await app.admin("/sites/blog")).json()) as { deployed: boolean; release: unknown; repo: boolean };
  assert.deepEqual({ deployed: detail.deployed, release: detail.release, repo: detail.repo }, { deployed: false, release: null, repo: false });
  assert.equal((await app.admin("/sites/blog/files")).status, 404);
  assert.equal((await app.admin("/sites/blog/deployments")).status, 200);
  assert.equal((await app.admin("/sites/blog/settings", "PUT", { vars: { A: "1" } })).status, 200);
  assert.equal((await app.admin("/sites/blog/members")).status, 200);
  // 配信はまだしない
  assert.equal((await fetch(`${app.base}/`, { headers: { "x-forwarded-host": "news.localhost" } })).status, 404);

  // 空のサイトへのデプロイは上書きの確認なし。デプロイ済みなら確認する
  assert.equal(((await (await app.admin("/site-name?name=blog")).json()) as { exists: boolean; created: boolean }).created, true);
  await app.deploy("blog");
  assert.equal(((await (await app.admin("/sites")).json()) as { sites: { deployed: boolean }[] }).sites[0].deployed, true);
  assert.equal(((await (await app.admin("/site-name?name=blog")).json()) as { exists: boolean }).exists, true);

  // メンバーはサイトを作れない
  const { api } = await member(app, ["blog"]);
  assert.equal((await api("/sites", "POST", { name: "mine" })).status, 403);
});

test("サイトを消すと同じ名前のリポジトリも消え、サイトのないリポジトリには起動時に空のサイトができる", async (t) => {
  const dataDir = tmpDir(t);
  const config = loadConfig({ KANZUME_DATA_DIR: dataDir });
  const first = await createServer(config);
  await first.sites.ensure("blog");
  await first.repos.create("blog");
  await first.repos.create("orphan");
  first.server.close();

  const second = await createServer(config);
  t.after(() => second.server.close());
  assert.equal(second.sites.has("orphan"), true);
  assert.equal(second.sites.deployed("orphan"), false);
  await new Promise<void>((resolve) => second.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(second.server.address() as AddressInfo).port}`;
  const cookie = `kanzume_session=${await second.state.createSession()}`;
  const res = await fetch(`${base}/_admin/kanzume/api/sites/blog`, { method: "DELETE", headers: { cookie, origin: base } });
  assert.equal(res.status, 200);
  assert.equal(await second.repos.exists("blog"), false);
  assert.equal(await second.repos.exists("orphan"), true);
});
