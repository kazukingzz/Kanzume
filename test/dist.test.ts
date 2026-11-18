import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AdminState } from "../src/admin/state.ts";
import { Sites } from "../src/sites.ts";
import { until, writeTree } from "./helpers.ts";

/**
 * 配る版（scripts/build.mjs で dist/ にまとめたもの。Docker イメージが動かすのと同じ）を、そのまま起動して確かめる。
 * ほかのテストは TypeScript のまま動かすので、まとめたときにだけ変わるところ（ファイルの場所・子プロセス・フック）をここで見る
 */

const ROOT = path.join(import.meta.dirname, "..");
const NO_GIT = (() => {
  const exec = spawnSync("git", ["--exec-path"], { encoding: "utf8" });
  return exec.status !== 0 || !fs.existsSync(path.join(exec.stdout.trim(), "git-http-backend")) ? "git と git-http-backend が必要" : false;
})();
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

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });

/** 本体の子プロセス（Worker の子・esbuild など）のコマンドライン */
const childrenOf = (pid: number) =>
  execFileSync("ps", ["-o", "ppid=,args=", "-e"], { encoding: "utf8" })
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.split(/\s+/)[0] === String(pid))
    .map((l) => l.replace(/^\d+\s+/, ""));

test("まとめた版（dist/）で、管理画面・静的サイト・Worker の子プロセス・git push のデプロイが動く", { skip: NO_GIT }, async (t) => {
  // Docker イメージと同じ並び（app/dist・app/web・app/node_modules）を一時ディレクトリに作る。
  // リポジトリの場所は、Worker の子プロセス（別のユーザー）からたどれるとは限らないため
  const app = fs.mkdtempSync(path.join(os.tmpdir(), "kanzume-test-"));
  fs.chmodSync(app, 0o755);
  t.after(() => fs.rmSync(app, { recursive: true, force: true }));
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "build.mjs"), path.join(app, "dist")], { stdio: "ignore" });
  fs.symlinkSync(path.join(ROOT, "web"), path.join(app, "web"));
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(app, "node_modules"));

  // データは先に作っておく（サイトと、管理者の個人トークン）
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kanzume-test-"));
  const state = new AdminState(dataDir);
  await state.init();
  await state.addCredential({ id: "c1", publicKey: "AAAA", counter: 0, createdAt: new Date().toISOString() });
  const { token } = await state.createUserToken(state.setupUserId, "test", null);
  await state.flush();
  const sites = new Sites(dataDir);
  await sites.init();
  await sites.ensure("blog");

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let output = "";
  let server: ChildProcess | null = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(app, "dist", "server.mjs")], {
    env: { PATH: process.env.PATH, KANZUME_DATA_DIR: dataDir, PORT: String(port), KANZUME_SETUP_TOKEN: "setup", NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", (d) => (output += d));
  server.stderr?.on("data", (d) => (output += d));
  const pid = server.pid!;
  t.after(async () => {
    const exited = new Promise((resolve) => server?.once("exit", resolve));
    server?.kill("SIGKILL");
    await exited;
    server = null;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  let up = false;
  await until(() => {
    void fetch(`${base}/_health`).then(
      (r) => (up = r.ok),
      () => {},
    );
    return up;
  }, 15_000);
  assert.equal(up, true, `起動しない:\n${output}`);

  // 管理画面のファイル（dist/ の外の web/admin を返す）
  const admin = await fetch(`${base}/_admin/kanzume/`);
  assert.equal(admin.status, 200);
  assert.match(await admin.text(), /js\/main\.js/);
  assert.equal((await fetch(`${base}/_admin/kanzume/js/main.js`)).status, 200);
  // パスキーのライブラリ（別のファイルに分けてある）を、使うときに読み込める
  const options = await fetch(`${base}/_admin/kanzume/api/login/options`, { method: "POST", headers: { origin: base } });
  assert.equal(options.status, 200, await options.clone().text());

  // git push: フック（dist/hooks/*.mjs）が動き、Kanzume の中でバンドルしてデプロイする
  const repo = await fetch(`${base}/_admin/kanzume/api/repos`, { method: "POST" });
  assert.equal(repo.status, 403, "Origin のない POST は受けない");
  execFileSync("git", ["init", "-q", "--bare", "--initial-branch=main", path.join(dataDir, "repos", "blog.git")], { env: GIT_ENV });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "kanzume-test-"));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", "-b", "main", work], { env: GIT_ENV });
  writeTree(work, {
    "wrangler.jsonc": JSON.stringify({ name: "x", main: "src/index.js", assets: { directory: "public" } }),
    "src/index.js": `export default { fetch() { return new Response("worker from dist"); } };`,
    "public/hello.txt": "static from dist",
  });
  execFileSync("git", ["add", "-A"], { cwd: work, env: GIT_ENV });
  execFileSync("git", ["commit", "-q", "-m", "最初のコミット"], { cwd: work, env: GIT_ENV });
  const push = await new Promise<{ status: number; output: string }>((resolve) => {
    const child = spawn("git", ["push", `http://x:${token}@127.0.0.1:${port}/_git/blog.git`, "main"], { cwd: work, env: GIT_ENV });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (status) => resolve({ status: status ?? 1, output: out }));
  });
  assert.equal(push.status, 0, `${push.output}\n${output}`);
  assert.match(push.output, /remote: デプロイしました/, `${push.output}\n${output}`);

  // 静的ファイルは本体が返し、それ以外は Worker（子プロセス）が返す
  const site = (p: string) => fetch(`${base}${p}`, { headers: { "x-forwarded-host": "blog.localhost" } });
  assert.equal(await (await site("/hello.txt")).text(), "static from dist");
  assert.equal(await (await site("/api")).text(), "worker from dist", output);

  const children = childrenOf(pid);
  assert.ok(
    children.some((c) => c.includes(path.join("dist", "child", "child.mjs"))),
    `子プロセスは dist/child/child.mjs で動く:\n${children.join("\n")}`,
  );
  // esbuild の常駐プロセスは、デプロイが終わったら止める（残すと約 17 MiB 使い続ける）
  await until(() => !childrenOf(pid).some((c) => c.includes("esbuild")), 5000);
  assert.deepEqual(
    childrenOf(pid).filter((c) => c.includes("esbuild")),
    [],
  );
});
