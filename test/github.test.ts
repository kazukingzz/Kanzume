import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { closeSiteDb } from "../src/bindings/db.ts";
import { loadConfig } from "../src/config.ts";
import { deployFromGitHub, GitHubError, parseGitHubUrl } from "../src/deploy/github.ts";
import { createServer } from "../src/server.ts";
import { tmpDir, writeTree } from "./helpers.ts";

const EXAMPLE = path.join(import.meta.dirname, "..", "examples", "worker");
const SHA = "0123456789abcdef0123456789abcdef01234567";

function repoTarball(t: TestContext, files: Record<string, string | Buffer>): Buffer {
  const dir = tmpDir(t);
  writeTree(path.join(dir, "kanzume-main"), files);
  const out = path.join(dir, "repo.tar.gz");
  execFileSync("tar", ["-czf", out, "-C", dir, "kanzume-main"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  return fs.readFileSync(out);
}

function exampleFiles(): Record<string, Buffer> {
  const out: Record<string, Buffer> = {};
  for (const rel of ["wrangler.jsonc", "package.json", "src/index.ts", "public/index.html"]) {
    out[`examples/worker/${rel}`] = fs.readFileSync(path.join(EXAMPLE, rel));
  }
  return out;
}

function fakeGitHub(tarball: Buffer, branches: string[] = ["main"]) {
  const requests: string[] = [];
  const fetcher = (async (input: string | URL) => {
    const url = String(input);
    requests.push(url);
    if (url === "https://api.test/repos/kazukingzz/kanzume") return Response.json({ default_branch: "main" });
    const commit = /^https:\/\/api\.test\/repos\/kazukingzz\/kanzume\/commits\/(.+)$/.exec(url);
    if (commit) {
      return branches.includes(decodeURIComponent(commit[1]))
        ? Response.json({ sha: SHA, commit: { message: "サンプルを追加\n\n詳細", author: { name: "kazu" } } })
        : new Response("not found", { status: 404 });
    }
    if (url === `https://codeload.test/kazukingzz/kanzume/tar.gz/${SHA}`) return new Response(new Uint8Array(tarball));
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetcher, requests };
}

async function start(t: TestContext) {
  const app = await createServer(loadConfig({ KANZUME_DATA_DIR: tmpDir(t) }));
  t.after(() => {
    app.server.close();
    
  });
  return app;
}

test("GitHub の URL からリポジトリ・ブランチ・ディレクトリを読み取る", () => {
  assert.deepEqual(parseGitHubUrl("https://github.com/kazukingzz/kanzume"), { owner: "kazukingzz", repo: "kanzume", rest: [] });
  assert.deepEqual(parseGitHubUrl("github.com/kazukingzz/kanzume.git"), { owner: "kazukingzz", repo: "kanzume", rest: [] });
  assert.deepEqual(parseGitHubUrl("https://github.com/kazukingzz/kanzume/tree/main/examples/worker"), {
    owner: "kazukingzz",
    repo: "kanzume",
    rest: ["main", "examples", "worker"],
  });
  for (const bad of ["https://gitlab.com/a/b", "https://github.com/a", "https://github.com/a/b/blob/main/x", "not a url"]) {
    assert.throws(() => parseGitHubUrl(bad), GitHubError, bad);
  }
});

test("このリポジトリの examples/worker を GitHub の URL からデプロイでき、KV・R2・アセット・node:buffer が動く", async (t) => {
  const app = await start(t);
  const { fetcher } = fakeGitHub(repoTarball(t, exampleFiles()));
  const result = await deployFromGitHub("https://github.com/kazukingzz/kanzume/tree/main/examples/worker", app.deployer, {
    autoRoot: true,
    fetch: fetcher,
    apiBase: "https://api.test",
    codeloadBase: "https://codeload.test",
    maxBytes: 10 * 1024 * 1024,
  });
  assert.equal(result.ok, true, result.ok ? "" : result.error);

  const release = app.sites.get(app.sites.root ?? "")?.get()!;
  assert.equal(release.manifest.name, "kanzume-example");
  const worker = await app.runtime.get(release);
  const hello = await worker.fetch(new Request("http://x/api/hello"));
  assert.deepEqual(await hello.response!.json(), { message: "Hello from Kanzume" });
  const b64 = await worker.fetch(new Request("http://x/api/base64", { method: "POST", body: "abc" }));
  assert.equal(await b64.response!.text(), "YWJj");
  assert.ok(fs.existsSync(path.join(release.dir, "assets", "index.html")));
  await worker.fetch(new Request("http://x/api/files/x.html", { method: "PUT", headers: { "content-type": "text/html" }, body: "<script>alert(1)</script>" }));
  const file = (await worker.fetch(new Request("http://x/api/files/x.html"))).response!;
  assert.equal(file.headers.get("content-disposition"), "attachment");
  assert.equal(file.headers.get("x-content-type-options"), "nosniff");

  const [d] = app.history.list();
  assert.equal(d.status, "success");
  assert.deepEqual(d.source, {
    repository: "kazukingzz/kanzume",
    ref: "main",
    sha: SHA,
    commitMessage: "サンプルを追加",
    actor: "kazu",
    serverUrl: "https://github.com",
  });
  assert.match(app.history.get(d.id)!.buildLog, /バンドルしました: worker\/index\.cjs/);
  const sources = JSON.parse(fs.readFileSync(path.join(release.dir, "_sources.json"), "utf8")) as { path: string }[];
  assert.deepEqual(sources.map((s) => s.path), ["src/index.ts"]);
});

test("スラッシュを含むブランチ名とリポジトリのトップを解決できる", async (t) => {
  const app = await start(t);
  const files = { "wrangler.json": JSON.stringify({ name: "top", assets: { directory: "site" } }), "site/index.html": "top" };
  const { fetcher, requests } = fakeGitHub(repoTarball(t, files), ["feature/x", "main"]);
  const opts = { fetch: fetcher, apiBase: "https://api.test", codeloadBase: "https://codeload.test", maxBytes: 1024 * 1024 };

  const nested = await deployFromGitHub("https://github.com/kazukingzz/kanzume/tree/feature/x", app.deployer, opts);
  assert.equal(nested.ok, true);
  assert.ok(requests.includes("https://api.test/repos/kazukingzz/kanzume/commits/feature%2Fx"));
  assert.equal(app.history.list()[0].source.ref, "feature/x");

  const top = await deployFromGitHub("https://github.com/kazukingzz/kanzume", app.deployer, opts);
  assert.equal(top.ok, true);
  assert.equal(app.history.list()[0].source.ref, "main");
});

test("デプロイできないリポジトリは理由付きの失敗として履歴に残る", async (t) => {
  const app = await start(t);
  const opts = (tarball: Buffer) => {
    const { fetcher } = fakeGitHub(tarball);
    return { fetch: fetcher, apiBase: "https://api.test", codeloadBase: "https://codeload.test", maxBytes: 1024 * 1024 };
  };
  const url = "https://github.com/kazukingzz/kanzume/tree/main/app";

  const npm = repoTarball(t, {
    "app/wrangler.jsonc": JSON.stringify({ name: "npm", main: "src/index.ts" }),
    "app/src/index.ts": `import { Hono } from "hono"; export default new Hono();`,
  });
  const npmResult = await deployFromGitHub(url, app.deployer, opts(npm));
  assert.equal(npmResult.ok, false);
  assert.match(npmResult.ok ? "" : npmResult.error, /hono[\s\S]*GitHub Actions/);

  const noAssets = repoTarball(t, { "app/wrangler.jsonc": JSON.stringify({ name: "spa", assets: { directory: "dist" } }) });
  const assetsResult = await deployFromGitHub(url, app.deployer, opts(noAssets));
  assert.match(assetsResult.ok ? "" : assetsResult.error, /dist.*ありません/);

  const noConfig = repoTarball(t, { "app/README.md": "hi" });
  const configResult = await deployFromGitHub(url, app.deployer, opts(noConfig));
  assert.match(configResult.ok ? "" : configResult.error, /wrangler/);

  const missingBranch = await deployFromGitHub("https://github.com/kazukingzz/kanzume/tree/nope", app.deployer, opts(noConfig));
  assert.match(missingBranch.ok ? "" : missingBranch.error, /nope.*見つかりません/);

  const empty = (async (input: string | URL) =>
    String(input).includes("/commits/") ? new Response("{}", { status: 409 }) : Response.json({ default_branch: "main" })) as typeof fetch;
  const emptyResult = await deployFromGitHub("https://github.com/kazukingzz/kanzume", app.deployer, { ...opts(noConfig), fetch: empty });
  assert.match(emptyResult.ok ? "" : emptyResult.error, /空のリポジトリ/);

  assert.equal(app.sites.get(app.sites.root ?? "")?.get(), undefined);
  const history = app.history.list();
  assert.equal(history.length, 5);
  assert.ok(history.every((d) => d.status === "failed"));
  assert.equal(history[4].name, "npm");
});

test("リポジトリの外のファイルを import・alias するリポジトリはバンドルせずに失敗する", async (t) => {
  const app = await start(t);
  const secretDir = tmpDir(t);
  const secret = path.join(secretDir, "admin.json");
  fs.writeFileSync(secret, JSON.stringify({ deployToken: "kz_secret_value" }));
  const url = "https://github.com/kazukingzz/kanzume/tree/main/app";
  const run = async (files: Record<string, string>) => {
    const { fetcher } = fakeGitHub(repoTarball(t, files));
    return deployFromGitHub(url, app.deployer, { fetch: fetcher, apiBase: "https://api.test", codeloadBase: "https://codeload.test", maxBytes: 1024 * 1024 });
  };
  const config = (extra: Record<string, unknown> = {}) => JSON.stringify({ name: "evil", main: "src/index.ts", ...extra });

  const absolute = await run({
    "app/wrangler.jsonc": config(),
    "app/src/index.ts": `import s from ${JSON.stringify(secret)}; export default { fetch() { return Response.json(s); } };`,
  });
  assert.match(absolute.ok ? "" : absolute.error, /リポジトリの外/);

  const relative = await run({
    "app/wrangler.jsonc": config(),
    "app/src/index.ts": `import s from "${"../".repeat(12)}${secret.slice(1)}"; export default { fetch() { return Response.json(s); } };`,
  });
  assert.match(relative.ok ? "" : relative.error, /リポジトリの外/);

  const aliased = await run({
    "app/wrangler.jsonc": config({ alias: { secret } }),
    "app/src/index.ts": `import s from "secret"; export default { fetch() { return Response.json(s); } };`,
  });
  assert.match(aliased.ok ? "" : aliased.error, /alias/);

  assert.equal(app.sites.get(app.sites.root ?? "")?.get(), undefined);
  for (const d of app.history.list()) {
    const full = app.history.get(d.id)!;
    assert.doesNotMatch(full.log + full.buildLog, /kz_secret_value/);
  }
});

test("管理画面: URL を読み、サイト名・環境変数・シークレットを決めてデプロイし、デプロイ後も設定を変えられる", async (t) => {
  const worker = `export default { async fetch(request, env) { return Response.json({ GREETING: env.GREETING, API_KEY: env.API_KEY ?? null, LEVEL: env.LEVEL ?? null }); } };`;
  const { fetcher } = fakeGitHub(
    repoTarball(t, {
      // name がない設定でも、管理画面でサイト名を決めればデプロイできる
      "apps/hello/wrangler.jsonc": `{ "main": "index.js", "compatibility_date": "2026-10-01", "vars": { "GREETING": "wrangler", "LEVEL": "1", "OBJ": { "a": 1 } } }`,
      "apps/hello/index.js": worker,
    }),
  );
  const app = await createServer(loadConfig({ KANZUME_DATA_DIR: tmpDir(t) }), { github: { fetch: fetcher, apiBase: "https://api.test", codeloadBase: "https://codeload.test" } });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.server.close());
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const cookie = `kanzume_session=${await app.state.createSession()}`;
  const api = (p: string, method = "GET", body?: unknown) =>
    fetch(`${base}/_admin/kanzume/api${p}`, { method, headers: { cookie, origin: base, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const site = async (host: string) => fetch(`${base}/`, { headers: { "x-forwarded-host": host } });
  const url = "https://github.com/kazukingzz/kanzume/tree/main/apps/hello";

  const inspect = await api("/deploy-github/inspect", "POST", { url });
  assert.equal(inspect.status, 200);
  const info = (await inspect.json()) as Record<string, unknown>;
  assert.deepEqual(info, { name: "hello", vars: { GREETING: "wrangler", LEVEL: "1" } }, "name がなければディレクトリ名。文字列でない vars は初期値に入れず、ほかのサイトの情報は返さない");

  const deploy = await api("/deploy-github", "POST", { url, name: "blog", vars: { GREETING: "settings" }, secrets: { API_KEY: "s3cret" } });
  assert.equal(deploy.status, 200, await deploy.clone().text());
  assert.deepEqual(await (await site("blog.localhost")).json(), { GREETING: "settings", API_KEY: "s3cret", LEVEL: "1" });

  // 同じ名前で確認なしだと 409、確認すれば上書き
  assert.equal((await api("/deploy-github", "POST", { url, name: "blog", vars: {}, secrets: {} })).status, 409);
  assert.equal(((await (await api("/site-name?name=blog")).json()) as { exists: boolean }).exists, true);

  // シークレットの値は返さない
  const settings = (await (await api("/sites/blog/settings")).json()) as Record<string, unknown>;
  assert.deepEqual(settings.secretKeys, ["API_KEY"]);
  assert.ok(!JSON.stringify(settings).includes("s3cret"));
  assert.deepEqual(settings.vars, { GREETING: "settings" });

  // 再デプロイしなくても次のリクエストから反映される。null のシークレットは消え、書かなかったものは残る
  await api("/sites/blog/settings", "PUT", { secrets: { TOKEN2: "x" } });
  assert.equal((await api("/sites/blog/settings", "PUT", { vars: { GREETING: "changed", LEVEL: "9" }, secrets: { API_KEY: null } })).status, 200);
  assert.deepEqual(await (await site("blog.localhost")).json(), { GREETING: "changed", API_KEY: null, LEVEL: "9" });
  assert.deepEqual(((await (await api("/sites/blog/settings")).json()) as { secretKeys: string[] }).secretKeys, ["TOKEN2"]);
  assert.equal((await api("/sites/blog/settings", "PUT", { vars: { "1BAD": "x" } })).status, 400);

  // サブドメインを変えると新しいサブドメインで配信し、前のサブドメインでは配信しない。サイトの ID は変わらない
  const deploy2 = await api("/deploy-github", "POST", { url, name: "shop", vars: {}, secrets: {} });
  assert.equal(deploy2.status, 200);
  assert.equal((await api("/sites/blog/settings", "PUT", { subdomain: "shop" })).status, 400, "ほかのサイトのサブドメインは使えない");
  const moved = await api("/sites/blog/settings", "PUT", { subdomain: "news" });
  assert.equal(moved.status, 200);
  assert.match(((await moved.json()) as { subdomainUrl: string }).subdomainUrl, /^http:\/\/news\./);
  assert.equal(((await (await site("news.localhost")).json()) as { GREETING: string }).GREETING, "changed");
  assert.equal(app.sites.resolve("blog"), undefined, "前のサブドメインはサイトとして扱わない");
  assert.ok(app.sites.has("blog"));
  // 使われているサブドメインと同じ名前の新しいサイトは作らない
  const taken = await api("/deploy-github", "POST", { url, name: "news", vars: {}, secrets: {} });
  assert.equal(taken.status, 400);
  // 戻せる
  assert.equal((await api("/sites/blog/settings", "PUT", { subdomain: "" })).status, 200);
  assert.equal(((await (await site("blog.localhost")).json()) as { GREETING: string }).GREETING, "changed");
});

test("メンバーが管理画面の GitHub デプロイで自分のサイトをデプロイしても、ルートにはならない", async (t) => {
  const { fetcher } = fakeGitHub(repoTarball(t, { "apps/hello/wrangler.jsonc": `{ "main": "index.js", "compatibility_date": "2026-10-01" }`, "apps/hello/index.js": "export default { fetch() { return new Response('hi'); } };" }));
  const app = await createServer(loadConfig({ KANZUME_DATA_DIR: tmpDir(t) }), { github: { fetch: fetcher, apiBase: "https://api.test", codeloadBase: "https://codeload.test" } });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.server.close());
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  await app.sites.ensure("blog");
  const user = await app.state.createUser("m", "member", ["blog"]);
  const cookie = `kanzume_session=${await app.state.createSession(user.id)}`;
  const res = await fetch(`${base}/_admin/kanzume/api/deploy-github`, {
    method: "POST",
    headers: { cookie, origin: base, "content-type": "application/json" },
    body: JSON.stringify({ url: "https://github.com/kazukingzz/kanzume/tree/main/apps/hello", name: "blog" }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(app.sites.deployed("blog"), true);
  assert.equal(app.sites.root, null, "ルートは管理画面と同じオリジンなので、メンバーのデプロイでは決めない");
});

test("既存のサイトの GitHub からの再デプロイに失敗したら、環境変数は元に戻る", async (t) => {
  const { fetcher } = fakeGitHub(repoTarball(t, { "apps/broken/index.js": "export default {}" }));
  const app = await createServer(loadConfig({ KANZUME_DATA_DIR: tmpDir(t) }), { github: { fetch: fetcher, apiBase: "https://api.test", codeloadBase: "https://codeload.test" } });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.server.close());
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  await app.sites.ensure("blog");
  await app.sites.updateSettings("blog", { vars: { API: "old" }, secrets: { KEY: "k" } });
  const cookie = `kanzume_session=${await app.state.createSession()}`;
  const res = await fetch(`${base}/_admin/kanzume/api/deploy-github`, {
    method: "POST",
    headers: { cookie, origin: base, "content-type": "application/json" },
    body: JSON.stringify({ url: "https://github.com/kazukingzz/kanzume/tree/main/apps/broken", name: "blog", vars: { API: "new" }, secrets: { KEY: null } }),
  });
  assert.equal(res.status, 400);
  assert.deepEqual(app.sites.settings("blog").vars, { API: "old" });
  assert.deepEqual(app.sites.settings("blog").secrets, { KEY: "k" });
  assert.ok(app.sites.has("blog"), "作成済みのサイトは消さない");
});
