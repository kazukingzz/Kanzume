import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { loadConfig } from "../src/config.ts";
import { createServer } from "../src/server.ts";
import { tmpDir, writeTree } from "./helpers.ts";

async function start(t: TestContext) {
  const app = await createServer(loadConfig({ KANZUME_DATA_DIR: tmpDir(t), KANZUME_SETUP_TOKEN: "setup" }));
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    await app.state.flush();
  });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const remote = (repo: string, token = app.state.deployToken) => `${base.replace("://", `://x:${token}@`)}/_git/${repo}.git`;
  return { ...app, base, remote };
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

if (spawnSync("git", ["--version"]).status !== 0) test.skip("git がない環境では動かさない");

test("Kanzume のリポジトリに main を push すると、wrangler の設定どおりにデプロイされる", async (t) => {
  const { base, remote, repos, sites, history } = await start(t);
  await repos.create("blog");
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
  assert.deepEqual({ repository: d.source.repository, ref: d.source.ref, commitMessage: d.source.commitMessage, actor: d.source.actor }, {
    repository: "blog",
    ref: "main",
    commitMessage: "最初のコミット",
    actor: "テスト",
  });

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

test("トークンがないと clone も push もできず、read トークンは clone だけ、期限切れは使えない", async (t) => {
  const { remote, repos, state } = await start(t);
  await repos.create("blog");
  const dir = workTree(t, WORKER);
  assert.equal((await git(dir, ["push", remote("blog"), "main"])).status, 0);

  const noToken = await git(tmpDir(t), ["clone", remote("blog", "").replace("x:@", ""), "c1"]);
  assert.notEqual(noToken.status, 0);

  const { token: read } = await state.createRepoToken("blog", "read", 3600);
  const cloned = await git(tmpDir(t), ["clone", remote("blog", read), "c2"]);
  assert.equal(cloned.status, 0, cloned.output);
  const denied = await git(dir, ["push", remote("blog", read), "main:other"]);
  assert.notEqual(denied.status, 0);
  assert.match(denied.output, /403/);

  const { token: otherRepo } = await state.createRepoToken("shop", "write", null);
  assert.notEqual((await git(tmpDir(t), ["clone", remote("blog", otherRepo), "c3"])).status, 0, "別のリポジトリのトークンは使えない");

  const { token: expired } = await state.createRepoToken("blog", "write", 1);
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(state.repoAccess("blog", expired), null);
  assert.equal(state.repoAccess("blog", read), "read");
  assert.equal(state.repoAccess("blog", state.deployToken), "write");
});

test("npm パッケージを import したリポジトリは、push は受け付けてデプロイの失敗理由を返す", async (t) => {
  const { remote, repos, history } = await start(t);
  await repos.create("app");
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

test("管理 API でリポジトリを作り、ブランチ・コミット・ファイルを読み、トークンを発行・取り消しできる", async (t) => {
  const { base, remote, state } = await start(t);
  const cookie = `kanzume_session=${await state.createSession()}`;
  const api = async (p: string, init: RequestInit = {}) => {
    const res = await fetch(`${base}/_admin/kanzume/api${p}`, { ...init, headers: { cookie, origin: base, "content-type": "application/json" } });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  assert.equal((await api("/repos", { method: "POST", body: JSON.stringify({ name: "Bad Name" }) })).status, 400);
  const created = await api("/repos", { method: "POST", body: JSON.stringify({ name: "blog" }) });
  assert.equal(created.body.cloneUrl, `${base}/_git/blog.git`);
  assert.equal((await api("/repos", { method: "POST", body: JSON.stringify({ name: "blog" }) })).status, 400, "同じ名前は作れない");

  const dir = workTree(t, WORKER);
  assert.equal((await git(dir, ["push", remote("blog"), "main"])).status, 0);

  const detail = (await api("/repos/blog")).body;
  assert.deepEqual(detail.refs.map((r: { branch: string }) => r.branch), ["main"]);
  assert.equal(detail.site, "blog");
  assert.deepEqual((await api("/repos/blog/log")).body.commits.map((c: { subject: string }) => c.subject), ["最初のコミット"]);
  assert.deepEqual((await api("/repos/blog/tree")).body.files.map((f: { path: string }) => f.path).sort(), ["public/robots.txt", "src/index.js", "src/label.js", "wrangler.jsonc"]);
  assert.equal((await api("/repos/blog/blob?path=public/robots.txt")).body.text, "User-agent: *");
  assert.equal((await api("/repos/blog/blob?path=../../etc/passwd")).status, 400);
  assert.equal((await api("/repos/blog/log?ref=--output=/tmp/x")).status, 400, "オプションに見える ref は弾く");

  const issued = (await api("/repos/blog/tokens", { method: "POST", body: JSON.stringify({ scope: "read", ttl: 3600 }) })).body;
  assert.match(issued.token, /^kzr_/);
  assert.equal(state.repoAccess("blog", issued.token), "read");
  assert.equal((await api("/repos/blog")).body.tokens.length, 1);
  assert.equal((await api(`/repos/blog/tokens/${issued.id}`, { method: "DELETE" })).status, 200);
  assert.equal(state.repoAccess("blog", issued.token), null);

  assert.equal((await api("/repos/blog", { method: "DELETE" })).status, 200);
  assert.deepEqual((await api("/repos")).body.repos, []);
});

test("リポジトリ名と違う name のコミットはデプロイせず、ほかのサイトを上書きできない", async (t) => {
  const { base, remote, repos, sites, state, history } = await start(t);
  await repos.create("blog");
  await repos.create("sample");
  assert.equal((await git(workTree(t, WORKER), ["push", remote("blog"), "main"])).status, 0);

  const { token } = await state.createRepoToken("sample", "write", 3600);
  const evil = workTree(t, { ...WORKER, "wrangler.jsonc": JSON.stringify({ name: "blog", main: "src/index.js", vars: { GREETING: "乗っ取り" } }) });
  const push = await git(evil, ["push", remote("sample", token), "main"]);
  assert.equal(push.status, 0, push.output);
  assert.match(push.output, /remote: デプロイに失敗しました: wrangler の name（blog）がリポジトリ名（sample）と違う/);
  assert.equal(await (await fetch(`${base}/x`)).text(), "hi from git", "blog はそのまま");
  assert.deepEqual(sites.list().map((s) => s.name), ["blog"]);
  assert.equal(history.list("blog").length, 1, "失敗の記録は blog の履歴に入らない");
  assert.equal(history.list("sample")[0].status, "failed");
});

test("ブランチの削除は拒否し、続けて push したときは新しいコミットが残る", async (t) => {
  const { base, remote, repos, state } = await start(t);
  await repos.create("blog");
  const dir = workTree(t, WORKER);
  assert.equal((await git(dir, ["push", remote("blog"), "main"])).status, 0);
  const del = await git(dir, ["push", remote("blog"), ":main"]);
  assert.notEqual(del.status, 0, del.output);
  assert.ok(await repos.resolve("blog", "refs/heads/main"));

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
