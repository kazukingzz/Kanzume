import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
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
    closeSiteDb(app.store.siteDir);
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
    fetch: fetcher,
    apiBase: "https://api.test",
    codeloadBase: "https://codeload.test",
    maxBytes: 10 * 1024 * 1024,
  });
  assert.equal(result.ok, true, result.ok ? "" : result.error);

  const release = app.store.get()!;
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

  assert.equal(app.store.get(), undefined);
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

  assert.equal(app.store.get(), undefined);
  for (const d of app.history.list()) {
    const full = app.history.get(d.id)!;
    assert.doesNotMatch(full.log + full.buildLog, /kz_secret_value/);
  }
});
