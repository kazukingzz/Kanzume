#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { esbuildArgs } from "./cjs.mjs";

const CONFIG_FILES = ["wrangler.jsonc", "wrangler.json", "wrangler.toml"];
const MAX_SOURCES_BYTES = 4 * 1024 * 1024;

const started = Date.now();
const buildLog = [];

function note(message) {
  console.log(message);
  buildLog.push(message);
}

function fail(message) {
  console.error(process.env.GITHUB_ACTIONS ? `::error::${message}` : `error: ${message}`);
  process.exit(1);
}

class BuildError extends Error {}

function run(cmd, args, options = {}) {
  note(`$ ${[cmd, ...args].join(" ")}`);
  const result = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trimEnd();
  if (output) {
    process.stdout.write(`${output}\n`);
    buildLog.push(output);
  }
  if (result.error) throw new BuildError(`${cmd} を実行できません: ${result.error.message}`);
  if (result.status !== 0) throw new BuildError(`${path.basename(cmd)} が失敗しました（終了コード ${result.status}）`);
}

function stripJsonc(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      out += text.slice(start, ++i);
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

// TOML パーサを同梱しないのは、Action を依存ゼロで動かすため。必要なのは name・main・assets.directory だけ
function readToml(text) {
  const out = { assets: {} };
  let section = "";
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[([^\]]+)\]/.exec(line);
    if (header) {
      section = header[1].trim();
      continue;
    }
    const kv = /^\s*([A-Za-z_]+)\s*=\s*["']([^"']*)["']/.exec(line);
    if (!kv) continue;
    if (section === "" && (kv[1] === "main" || kv[1] === "name")) out[kv[1]] = kv[2];
    if (section === "assets" && kv[1] === "directory") out.assets.directory = kv[2];
  }
  return out;
}

function git(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

function deploySource() {
  const env = process.env;
  const serverUrl = env.GITHUB_SERVER_URL || "https://github.com";
  const repository = env.GITHUB_REPOSITORY;
  return {
    repository,
    ref: env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || git(["rev-parse", "--abbrev-ref", "HEAD"]),
    sha: env.GITHUB_SHA || git(["rev-parse", "HEAD"]),
    actor: env.GITHUB_ACTOR || git(["log", "-1", "--format=%an"]),
    commitMessage: git(["log", "-1", "--format=%s"]),
    runUrl: repository && env.GITHUB_RUN_ID ? `${serverUrl}/${repository}/actions/runs/${env.GITHUB_RUN_ID}` : undefined,
    serverUrl: repository ? serverUrl : undefined,
  };
}

function collectSources(mapFile, bundledDir) {
  if (!fs.existsSync(mapFile)) return [];
  const map = JSON.parse(fs.readFileSync(mapFile, "utf8"));
  const out = [];
  let total = 0;
  (map.sources ?? []).forEach((src, i) => {
    const content = map.sourcesContent?.[i];
    if (typeof content !== "string") return;
    const rel = path.relative(process.cwd(), path.resolve(bundledDir, map.sourceRoot ?? "", src)).split(path.sep).join("/");
    if (rel.startsWith("..") || rel.split("/").includes("node_modules")) return;
    total += Buffer.byteLength(content);
    if (total <= MAX_SOURCES_BYTES) out.push({ path: rel, content });
  });
  return out;
}

async function post(endpoint, token, body, contentType) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": contentType },
    body,
  });
  const result = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  return { ok: res.ok, status: res.status, result };
}

const url = (process.env.KANZUME_URL || "").replace(/\/+$/, "");
const token = process.env.KANZUME_TOKEN || "";
if (!url) fail("url を指定してください（管理画面の KANZUME_URL）");
if (!token) fail("token を指定してください（管理画面の KANZUME_TOKEN）");

const configFile = CONFIG_FILES.find((f) => fs.existsSync(f));
if (!configFile) fail(`${CONFIG_FILES.join(" / ")} が見つかりません`);
const text = fs.readFileSync(configFile, "utf8");
const config = configFile.endsWith(".toml") ? readToml(text) : JSON.parse(stripJsonc(text));
const source = deploySource();

const stage = fs.mkdtempSync(path.join(os.tmpdir(), "kanzume-"));
fs.copyFileSync(configFile, path.join(stage, configFile));

try {
  if (config.main) {
    if (fs.existsSync("package.json") && !fs.existsSync("node_modules")) {
      if (fs.existsSync("pnpm-lock.yaml")) run("npx", ["--yes", "pnpm", "install", "--frozen-lockfile"]);
      else if (fs.existsSync("yarn.lock")) run("npx", ["--yes", "yarn", "install", "--frozen-lockfile"]);
      else if (fs.existsSync("bun.lock") || fs.existsSync("bun.lockb")) run("bun", ["install", "--frozen-lockfile"]);
      else if (fs.existsSync("package-lock.json")) run("npm", ["ci"]);
      else run("npm", ["install"]);
    }
    const bin = (name, pkg) => {
      const local = path.join("node_modules", ".bin", name);
      return fs.existsSync(local) ? [local, []] : ["npx", ["--yes", pkg]];
    };
    const bundled = path.join(stage, "bundled");
    const [wrangler, wranglerArgs] = bin("wrangler", "wrangler@4");
    run(wrangler, [...wranglerArgs, "deploy", "--dry-run", "--outdir", bundled], {
      env: { ...process.env, WRANGLER_SEND_METRICS: "false", FORCE_COLOR: "0" },
    });

    const base = path.basename(config.main).replace(/\.[^.]+$/, "");
    const workerDir = path.join(stage, "worker");
    fs.cpSync(bundled, workerDir, {
      recursive: true,
      filter: (src) => !/\.(js|mjs|map)$/.test(src) && path.basename(src) !== "README.md",
    });
    const [esbuild, esbuildPrefix] = bin("esbuild", "esbuild@0.28.2");
    run(esbuild, [...esbuildPrefix, ...esbuildArgs(path.join(bundled, `${base}.js`), path.join(workerDir, `${base}.cjs`))]);
    const sources = collectSources(path.join(bundled, `${base}.js.map`), bundled);
    fs.mkdirSync(path.join(stage, ".kanzume"), { recursive: true });
    fs.writeFileSync(path.join(stage, ".kanzume", "sources.json"), JSON.stringify(sources));
    note(`ソース ${sources.length} ファイルを同梱します`);
    fs.rmSync(bundled, { recursive: true, force: true });
  }

  const assetsDir = config.assets?.directory;
  if (assetsDir) {
    if (!fs.existsSync(assetsDir)) throw new BuildError(`assets.directory（${assetsDir}）がありません。先にビルドしてください`);
    fs.cpSync(assetsDir, path.join(stage, "assets"), {
      recursive: true,
      filter: (src) => path.basename(src) !== ".assetsignore",
    });
  }
} catch (err) {
  if (!(err instanceof BuildError)) throw err;
  note(`ビルドに失敗しました: ${err.message}`);
  if (typeof config.name === "string") {
    await post(
      `${url}/_api/deploy/report`,
      token,
      JSON.stringify({ name: config.name, error: err.message, source, buildLog: buildLog.join("\n"), durationMs: Date.now() - started }),
      "application/json",
    ).catch(() => {});
  }
  fs.rmSync(stage, { recursive: true, force: true });
  fail(err.message);
}

fs.mkdirSync(path.join(stage, ".kanzume"), { recursive: true });
fs.writeFileSync(path.join(stage, ".kanzume", "meta.json"), JSON.stringify({ source }));
fs.writeFileSync(path.join(stage, ".kanzume", "build.log"), buildLog.join("\n"));

const archive = path.join(os.tmpdir(), `kanzume-${process.pid}.tar.gz`);
execFileSync("tar", ["-czf", archive, "-C", stage, "."], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
const body = fs.readFileSync(archive);
console.log(`アップロード: ${(body.length / 1024).toFixed(1)} KiB → ${url}`);

const { ok, status, result } = await post(`${url}/_api/deploy`, token, body, "application/gzip");
fs.rmSync(stage, { recursive: true, force: true });
fs.rmSync(archive, { force: true });
if (!ok) fail(`デプロイに失敗しました: ${result.error ?? `HTTP ${status}`}`);

console.log(`デプロイしました: ${result.url}`);
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `url=${result.url}\n`);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Kanzume にデプロイしました: ${result.url}\n`);
