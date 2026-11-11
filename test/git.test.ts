import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { tmpDir, until, writeTree } from "./helpers.ts";
import { startApp } from "./fixtures.ts";

async function start(t: TestContext) {
  const app = await startApp(t);
  const remote = (repo: string, token = app.token) => `${app.base.replace("://", `://x:${token}@`)}/_git/${repo}.git`;
  // 管理画面と同じく、サイトを追加してからリポジトリを作る（リポジトリはサイトに属する）
  const createRepo = async (name: string) => {
    await app.sites.ensure(name);
    await app.repos.create(name);
  };
  return { ...app, remote, createRepo };
}

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "テスト",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "テスト",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

// push はフックがサーバーに戻ってくるので、サーバーと同じプロセスで同期実行するとデッドロックする。非同期で動かす
function git(cwd: string, args: string[]): Promise<{ status: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, env: GIT_ENV });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("close", (status) => resolve({ status: status ?? 1, output }));
  });
}

function workTree(t: TestContext, files: Record<string, string>) {
  const dir = tmpDir(t);
  execFileSync("git", ["init", "-q", "-b", "main", dir], { env: GIT_ENV });
  writeTree(dir, files);
  execFileSync("git", ["add", "-A"], { cwd: dir, env: GIT_ENV });
  execFileSync("git", ["commit", "-q", "-m", "最初のコミット"], { cwd: dir, env: GIT_ENV });
  return dir;
}

const WORKER = {
  "wrangler.jsonc": JSON.stringify({ name: "blog", main: "src/index.js", assets: { directory: "public" }, vars: { GREETING: "hi" } }),
  "src/index.js": `import { label } from "./label.js";\nexport default { fetch(request, env) { return new Response(label(env.GREETING)); } };`,
  "src/label.js": `export const label = (g) => \`\${g} from git\`;`,
  "public/robots.txt": "User-agent: *",
};

// git（と git-http-backend）がない環境では、このファイルのテストはすべて飛ばす
const NO_GIT = (() => {
  const exec = spawnSync("git", ["--exec-path"], { encoding: "utf8" });
  return exec.status !== 0 || !existsSync(path.join(exec.stdout.trim(), "git-http-backend")) ? "git と git-http-backend が必要" : false;
})();

test("Kanzume のリポジトリに main を push すると、wrangler の設定どおりにデプロイされる", { skip: NO_GIT }, async (t) => {
  const { base, remote, repos, sites, history, createRepo } = await start(t);
  await createRepo("blog");
  const dir = workTree(t, WORKER);

  const push = await git(dir, ["push", remote("blog"), "main"]);
  assert.equal(push.status, 0, push.output);
  assert.match(push.output, /remote: .*git push（blog@main [0-9a-f]{7}）からデプロイします/);
  assert.match(push.output, /remote: デプロイしました: http:\/\/127\.0\.0\.1:\d+\//);

  assert.equal(sites.list()[0].name, "blog");
  assert.equal(await (await fetch(`${base}/x`)).text(), "hi from git");
  assert.equal(await (await fetch(`${base}/robots.txt`)).text(), "User-agent: *");
  const [d] = history.list("blog");
  assert.equal(d.status, "success");
  assert.deepEqual(
    { repository: d.source.repository, ref: d.source.ref, commitMessage: d.source.commitMessage, actor: d.source.actor },
    {
      repository: "blog",
      ref: "main",
      commitMessage: "最初のコミット",
      actor: "テスト",
    },
  );

  // main 以外への push は保存だけ
  execFileSync("git", ["checkout", "-q", "-b", "feature"], { cwd: dir, env: GIT_ENV });
  writeTree(dir, { "src/label.js": `export const label = (g) => \`\${g} from feature\`;` });
  execFileSync("git", ["commit", "-qam", "機能"], { cwd: dir, env: GIT_ENV });
  const feature = await git(dir, ["push", remote("blog"), "feature"]);
  assert.equal(feature.status, 0, feature.output);
  assert.match(feature.output, /remote: main 以外への push なので、保存だけしてデプロイはしません/);
  assert.equal(await (await fetch(`${base}/x`)).text(), "hi from git");
  assert.deepEqual((await repos.refs("blog")).map((r) => r.branch).sort(), ["feature", "main"]);

  // 強制 push も write なら通る
  execFileSync("git", ["checkout", "-q", "main"], { cwd: dir, env: GIT_ENV });
  execFileSync("git", ["commit", "-q", "--amend", "-m", "書き換え"], { cwd: dir, env: GIT_ENV });
  const forced = await git(dir, ["push", "--force", remote("blog"), "main"]);
  assert.equal(forced.status, 0, forced.output);
  assert.equal(history.list("blog")[0].source.commitMessage, "書き換え");
});

/** そのサイトだけのメンバーを作り、個人トークンを発行する */
async function memberToken(state: Awaited<ReturnType<typeof start>>["state"], sites: string[], ttl: number | null = 3600) {
  const user = await state.createUser("メンバー", "member", sites);
  return (await state.createUserToken(user.id, "test", ttl)).token;
}

test("トークンがないと clone も push もできず、個人トークンは参加しているサイトのリポジトリだけ、期限切れは使えない", { skip: NO_GIT }, async (t) => {
  const { remote, state, createRepo } = await start(t);
  await createRepo("blog");
  const dir = workTree(t, WORKER);
  assert.equal((await git(dir, ["push", remote("blog"), "main"])).status, 0);

  const noToken = await git(tmpDir(t), ["clone", remote("blog", "").replace("x:@", ""), "c1"]);
  assert.notEqual(noToken.status, 0);

  const mine = await memberToken(state, ["blog"]);
  const cloned = await git(tmpDir(t), ["clone", remote("blog", mine), "c2"]);
  assert.equal(cloned.status, 0, cloned.output);
  assert.equal((await git(dir, ["push", remote("blog", mine), "main:other"])).status, 0, "メンバーは自分のサイトのリポジトリに push できる");

  const other = await memberToken(state, ["shop"]);
  assert.notEqual((await git(tmpDir(t), ["clone", remote("blog", other), "c3"])).status, 0, "参加していないサイトのリポジトリは使えない");

  const expired = await memberToken(state, ["blog"], 1);
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(state.repoAccess("blog", expired), false);
  assert.equal(state.repoAccess("blog", mine), true);
  const admin = (await state.createUserToken(state.setupUserId, "admin", null)).token;
  assert.equal(state.repoAccess("anything", admin), true, "管理者の個人トークンはすべてのリポジトリ");
});

test("npm パッケージを import したリポジトリは、push は受け付けてデプロイの失敗理由を返す", { skip: NO_GIT }, async (t) => {
  const { remote, repos, history, createRepo } = await start(t);
  await createRepo("app");
  const dir = workTree(t, {
    "wrangler.json": JSON.stringify({ name: "app", main: "index.js" }),
    "index.js": `import { Hono } from "hono";\nexport default new Hono();`,
  });
  const push = await git(dir, ["push", remote("app"), "main"]);
  assert.equal(push.status, 0, push.output);
  assert.match(push.output, /remote: デプロイに失敗しました: .*hono/);
  assert.match(push.output, /GitHub Actions/);
  assert.equal(history.list("app")[0].status, "failed");
  assert.equal(path.basename(repos.path("app")), "app.git");
});

test("管理 API でリポジトリを作り、ブランチ・コミット・ファイルを読み、トークンを発行・取り消しできる", { skip: NO_GIT }, async (t) => {
  const { base, remote, state } = await start(t);
  const cookie = `kanzume_session=${await state.createSession()}`;
  const api = async (p: string, init: RequestInit = {}) => {
    const res = await fetch(`${base}/_admin/kanzume/api${p}`, { ...init, headers: { cookie, origin: base, "content-type": "application/json" } });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  assert.equal((await api("/repos", { method: "POST", body: JSON.stringify({ name: "Bad Name" }) })).status, 400);
  // リポジトリはサイトに属するので、先にサイトを作る
  const noSite = await api("/repos", { method: "POST", body: JSON.stringify({ name: "blog" }) });
  assert.equal(noSite.status, 400);
  assert.match(noSite.body.error, /先にサイトを作って/);
  assert.equal((await api("/sites", { method: "POST", body: JSON.stringify({ name: "blog" }) })).status, 200);
  const created = await api("/repos", { method: "POST", body: JSON.stringify({ name: "blog" }) });
  assert.equal(created.body.cloneUrl, `${base}/_git/blog.git`);
  assert.equal((await api("/repos", { method: "POST", body: JSON.stringify({ name: "blog" }) })).status, 400, "同じ名前は作れない");

  const dir = workTree(t, WORKER);
  assert.equal((await git(dir, ["push", remote("blog"), "main"])).status, 0);

  const detail = (await api("/repos/blog")).body;
  assert.deepEqual(
    detail.refs.map((r: { branch: string }) => r.branch),
    ["main"],
  );
  assert.equal(detail.site, "blog");
  assert.deepEqual(
    (await api("/repos/blog/log")).body.commits.map((c: { subject: string }) => c.subject),
    ["最初のコミット"],
  );
  assert.deepEqual((await api("/repos/blog/tree")).body.files.map((f: { path: string }) => f.path).sort(), [
    "public/robots.txt",
    "src/index.js",
    "src/label.js",
    "wrangler.jsonc",
  ]);
  assert.equal((await api("/repos/blog/blob?path=public/robots.txt")).body.text, "User-agent: *");
  assert.equal((await api("/repos/blog/blob?path=../../etc/passwd")).status, 400);
  assert.equal((await api("/repos/blog/log?ref=--output=/tmp/x")).status, 400, "オプションに見える ref は弾く");

  // 個人トークンは「設定」で発行・取り消しする（リポジトリごとのトークンはない）
  const issued = (await api("/tokens", { method: "POST", body: JSON.stringify({ name: "ノート PC", ttl: 3600 }) })).body;
  assert.match(issued.token, /^kzu_/);
  assert.equal(state.repoAccess("blog", issued.token), true);
  assert.deepEqual(
    (await api("/tokens")).body.tokens.map((t: { name: string }) => t.name).filter((n: string) => n !== "test"),
    ["ノート PC"],
  );
  assert.equal((await api(`/tokens/${issued.id}`, { method: "DELETE" })).status, 200);
  assert.equal(state.repoAccess("blog", issued.token), false);

  assert.equal((await api("/repos/blog", { method: "DELETE" })).status, 200);
  assert.deepEqual((await api("/repos")).body.repos, []);
});

test("name がほかのサイトのコミットも、リポジトリのサイトにデプロイし、ほかのサイトは上書きできない", { skip: NO_GIT }, async (t) => {
  const { base, remote, sites, state, history, createRepo } = await start(t);
  await createRepo("blog");
  await createRepo("sample");
  assert.equal((await git(workTree(t, WORKER), ["push", remote("blog"), "main"])).status, 0);

  const token = await memberToken(state, ["sample"]);
  const evil = workTree(t, { ...WORKER, "wrangler.jsonc": JSON.stringify({ name: "blog", main: "src/index.js", vars: { GREETING: "乗っ取り" } }) });
  const push = await git(evil, ["push", remote("sample", token), "main"]);
  assert.equal(push.status, 0, push.output);
  assert.match(push.output, /remote: デプロイしました/);
  assert.equal(await (await fetch(`${base}/x`)).text(), "hi from git", "blog はそのまま");
  assert.deepEqual(
    sites.list().map((s) => s.name),
    ["blog", "sample"],
  );
  assert.equal(history.list("blog").length, 1, "blog の履歴には入らない");
  assert.equal(history.list("sample")[0].status, "success");
  assert.equal(sites.settings("sample").vars.GREETING, undefined, "管理画面の設定は変わらない");
});

test("main の削除は拒否し（ほかのブランチは消せる）、続けて push したときは新しいコミットが残る", { skip: NO_GIT }, async (t) => {
  const { base, remote, repos, state, createRepo } = await start(t);
  await createRepo("blog");
  const dir = workTree(t, WORKER);
  assert.equal((await git(dir, ["push", remote("blog"), "main"])).status, 0);
  const del = await git(dir, ["push", remote("blog"), ":main"]);
  assert.notEqual(del.status, 0, del.output);
  assert.match(del.output, /main はデプロイ元なので削除できません/);
  assert.deepEqual(
    (await repos.refs("blog")).map((r) => r.branch),
    ["main"],
  );
  // main 以外のブランチは削除できる
  assert.equal((await git(dir, ["push", remote("blog"), "main:feature"])).status, 0);
  assert.equal((await git(dir, ["push", remote("blog"), ":feature"])).status, 0);
  assert.deepEqual(
    (await repos.refs("blog")).map((r) => r.branch),
    ["main"],
  );

  for (const v of ["v2", "v3"]) {
    writeTree(dir, { "src/label.js": `export const label = (g) => \`\${g} ${v}\`;` });
    execFileSync("git", ["commit", "-qam", v], { cwd: dir, env: GIT_ENV });
    assert.equal((await git(dir, ["push", remote("blog"), "main"])).status, 0);
  }
  assert.equal(await (await fetch(`${base}/x`)).text(), "hi v3");

  const cookie = `kanzume_session=${await state.createSession()}`;
  const blob = (p: string) => fetch(`${base}/_admin/kanzume/api/repos/blog/blob?path=${encodeURIComponent(p)}`, { headers: { cookie } });
  assert.equal((await blob("")).status, 404);
  assert.equal((await blob("src")).status, 404, "ディレクトリは 404");
  assert.equal((await blob("src/label.js")).status, 200);
});

test("git を起動できなくてもサーバーは落ちず、500 を返す", { skip: NO_GIT }, async (t) => {
  const { base, token, createRepo } = await start(t);
  await createRepo("blog");
  const path0 = process.env.PATH;
  process.env.PATH = "/nonexistent";
  t.after(() => (process.env.PATH = path0));
  const res = await fetch(`${base}/_git/blog.git/info/refs?service=git-upload-pack`, {
    headers: { authorization: `Basic ${Buffer.from(`x:${token}`).toString("base64")}` },
  });
  process.env.PATH = path0;
  assert.equal(res.status, 500);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await fetch(`${base}/_health`)).status, 200, "サーバーは動き続けている");
});

test("途中で切れた push の git プロセスは残らない", { skip: NO_GIT }, async (t) => {
  const { base, token, createRepo } = await start(t);
  await createRepo("blog");
  const children = () =>
    execFileSync("ps", ["-o", "pid=,ppid=,args=", "-e"], { encoding: "utf8" })
      .split("\n")
      .filter((l) => l.includes("http-backend") && l.trim().split(/\s+/)[1] === String(process.pid));
  const { request } = await import("node:http");
  const url = new URL(`${base}/_git/blog.git/git-receive-pack`);
  const req = request({
    host: url.hostname,
    port: url.port,
    path: url.pathname,
    method: "POST",
    headers: {
      "content-type": "application/x-git-receive-pack-request",
      "transfer-encoding": "chunked",
      authorization: `Basic ${Buffer.from(`x:${token}`).toString("base64")}`,
    },
  });
  req.on("error", () => {});
  // 長さだけを送って中身を送らない（git は続きを待ち続ける）
  req.write("0090");
  await until(() => children().length === 1);
  assert.equal(children().length, 1, "送信中は http-backend が動いている");
  req.destroy();
  await until(() => children().length === 0);
  assert.deepEqual(children(), [], "切れたら止まる");
});

test("IP アドレスの先頭の数字と同じ名前のサイトがあっても、フックは Kanzume に届く", { skip: NO_GIT }, async (t) => {
  const { remote, sites, createRepo } = await start(t);
  for (const name of ["127", "blog"]) await createRepo(name);
  const evil = workTree(t, {
    "wrangler.json": JSON.stringify({ name: "127", main: "i.js" }),
    "i.js": `export default { fetch() { return new Response("site 127 でフックを横取り"); } };`,
  });
  assert.equal((await git(evil, ["push", remote("127"), "main"])).status, 0);
  const push = await git(workTree(t, WORKER), ["push", remote("blog"), "main"]);
  assert.doesNotMatch(push.output, /横取り/);
  assert.match(push.output, /remote: デプロイしました/);
  assert.ok(sites.get("blog")?.get());
});

test("main という名前のタグがあっても、main への push はデプロイされる", { skip: NO_GIT }, async (t) => {
  const { base, remote, repos, createRepo } = await start(t);
  await createRepo("blog");
  const dir = workTree(t, WORKER);
  assert.equal((await git(dir, ["push", remote("blog"), "main"])).status, 0);
  assert.equal((await git(dir, ["push", remote("blog"), "main:refs/tags/main"])).status, 0);
  writeTree(dir, { "src/label.js": `export const label = (g) => \`\${g} after tag\`;` });
  execFileSync("git", ["commit", "-qam", "タグのあと"], { cwd: dir, env: GIT_ENV });
  const push = await git(dir, ["push", remote("blog"), "main"]);
  assert.match(push.output, /remote: デプロイしました/, push.output);
  assert.equal(await (await fetch(`${base}/x`)).text(), "hi after tag");
  assert.equal(await repos.defaultBranch("blog"), "main");
});

test("リポジトリの容量の上限を超える push は受け付けない", { skip: NO_GIT }, async (t) => {
  const app = await startApp(t, { KANZUME_REPO_QUOTA_MB: "0.05" });
  const base = app.base;
  await app.sites.ensure("blog");
  await app.repos.create("blog");
  const { randomBytes } = await import("node:crypto");
  const dir = workTree(t, { ...WORKER, "public/big.bin": randomBytes(200 * 1024).toString("base64") });
  const push = await git(dir, ["push", `${base.replace("://", `://x:${app.token}@`)}/_git/blog.git`, "main"]);
  assert.notEqual(push.status, 0);
  assert.match(push.output, /容量の上限/);
  assert.deepEqual(await app.repos.refs("blog"), []);
});

test("メンバーの最初の push はルートにならず、その後の管理者の push でもルートにならない", { skip: NO_GIT }, async (t) => {
  const { remote, sites, state, createRepo } = await start(t);
  for (const name of ["blog", "shop", "docs"]) await createRepo(name);
  const token = await memberToken(state, ["shop"]);
  const shop = workTree(t, { ...WORKER, "wrangler.jsonc": JSON.stringify({ name: "shop", main: "src/index.js" }) });
  assert.match((await git(shop, ["push", remote("shop", token), "main"])).output, /remote: デプロイしました/);
  assert.equal(sites.root, null, "メンバーのトークンでは自動でルートにしない");
  assert.match((await git(workTree(t, WORKER), ["push", remote("blog"), "main"])).output, /remote: デプロイしました/);
  assert.equal(sites.root, null, "最初のデプロイではないので、管理者の push でもルートにしない");

  assert.equal(sites.rootDecided, true, "メンバーの最初のデプロイで「ルートなし」に決まる");
});

test("管理者の最初の push はルートになる", { skip: NO_GIT }, async (t) => {
  const { remote, sites, createRepo } = await start(t);
  await createRepo("blog");
  assert.match((await git(workTree(t, WORKER), ["push", remote("blog"), "main"])).output, /remote: デプロイしました/);
  assert.equal(sites.root, "blog");
});

test("設定のない push は、ファイルを取り出す前に止まり、失敗はリポジトリの履歴に残る", { skip: NO_GIT }, async (t) => {
  const { remote, history, createRepo } = await start(t);
  await createRepo("sample");
  const noConfig = await git(workTree(t, { "index.js": "x" }), ["push", remote("sample"), "main"]);
  assert.match(noConfig.output, /wrangler\.jsonc \/ wrangler\.json \/ wrangler\.toml がありません/);
  const deployments = history.list("sample");
  assert.deepEqual(
    deployments.map((d) => d.status),
    ["failed"],
    "設定がない失敗もリポジトリの履歴に入る",
  );
  assert.doesNotMatch(history.get(deployments[0].id)!.log, /取り出し/, "ファイルを取り出していない");
});

test("壊れた .git があっても一覧は返り、service を 2 つ付けた info/refs は受けない、デプロイ済みのサイトにも確認なしでリポジトリを作れる", {
  skip: NO_GIT,
}, async (t) => {
  const { base, remote, repos, state, createRepo } = await start(t);
  await createRepo("blog");
  mkdirSync(path.join(repos.dir, "broken.git"));
  const cookie = `kanzume_session=${await state.createSession()}`;
  const api = async (p: string, init: RequestInit = {}) => {
    const res = await fetch(`${base}/_admin/kanzume/api${p}`, { ...init, headers: { cookie, origin: base, "content-type": "application/json" } });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const list = await api("/repos");
  assert.equal(list.status, 200);
  assert.deepEqual(
    list.body.repos.map((r: { name: string }) => r.name),
    ["blog"],
    "HEAD のないディレクトリは一覧に出さない",
  );

  const token = await memberToken(state, ["blog"]);
  const auth = { authorization: `Basic ${Buffer.from(`x:${token}`).toString("base64")}` };
  assert.equal((await fetch(`${base}/_git/blog.git/info/refs?service=git-upload-pack&service=git-receive-pack`, { headers: auth })).status, 404);
  assert.equal((await fetch(`${base}/_git/blog.git/info/refs?service=git-upload-pack`, { headers: auth })).status, 200);

  // サイト shop を（GitHub からなどで）先に作っておく
  await createRepo("shop");
  const shop = workTree(t, { "wrangler.json": JSON.stringify({ name: "shop", assets: { directory: "p" } }), "p/index.html": "shop" });
  assert.equal((await git(shop, ["push", remote("shop"), "main"])).status, 0);
  await repos.remove("shop");
  // デプロイ済みのサイトにも、確認なしでリポジトリを作れる（リポジトリはそのサイトのもの）
  assert.equal((await api("/repos", { method: "POST", body: JSON.stringify({ name: "shop" }) })).status, 200);
});
