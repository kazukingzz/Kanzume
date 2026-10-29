import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import type { UploadedFile } from "../store.ts";
import { DeployLog, type Deployer, type DeployResult } from "./deployer.ts";
import type { DeploySource } from "./history.ts";
import { readTar, TarError } from "./tar.ts";
import { CONFIG_FILES, ConfigError, parseWranglerConfig } from "./wrangler.ts";

export interface GitHubOptions {
  fetch?: typeof fetch;
  apiBase?: string;
  codeloadBase?: string;
  maxBytes: number;
}

export class GitHubError extends Error {}

interface RepoRef {
  owner: string;
  repo: string;
  rest: string[];
}

const NAME = /^[A-Za-z0-9_.-]+$/;
const TIMEOUT_MS = 30_000;

export function parseGitHubUrl(input: string): RepoRef {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//.test(input.trim()) ? input.trim() : `https://${input.trim()}`);
  } catch {
    throw new GitHubError("URL の形式が正しくありません");
  }
  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") throw new GitHubError("github.com の URL を指定してください");
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const [owner, repoRaw, kind, ...rest] = parts;
  const repo = repoRaw?.replace(/\.git$/, "");
  if (!owner || !repo || !NAME.test(owner) || !NAME.test(repo)) throw new GitHubError("https://github.com/<owner>/<repo> の形式で指定してください");
  if (kind !== undefined && kind !== "tree") throw new GitHubError("リポジトリのトップか、/tree/<ブランチ>/<ディレクトリ> の URL を指定してください");
  if (kind === "tree" && rest.length === 0) throw new GitHubError("/tree/ の後にブランチ名が必要です");
  if (rest.some((p) => p === ".." || p === ".")) throw new GitHubError("URL のパスが不正です");
  return { owner, repo, rest };
}

async function getJson(fetcher: typeof fetch, url: string): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const res = await fetcher(url, { headers: { accept: "application/vnd.github+json", "user-agent": "kanzume" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  return { status: res.status, body: res.ok ? ((await res.json()) as Record<string, unknown>) : null };
}

async function download(fetcher: typeof fetch, url: string, maxBytes: number): Promise<Buffer | null> {
  const res = await fetcher(url, { headers: { "user-agent": "kanzume" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 404) return null;
  if (!res.ok || !res.body) throw new GitHubError(`リポジトリをダウンロードできません（HTTP ${res.status}）`);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new GitHubError(`リポジトリが大きすぎます（${Math.round(maxBytes / 1024 / 1024)} MB まで）`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

interface Resolved {
  ref: string;
  dir: string[];
  sha?: string;
  message?: string;
  author?: string;
}

// ブランチ名に / を含められるので、/tree/ 以降のどこまでがブランチかは GitHub に問い合わせて決める
async function resolveRef(fetcher: typeof fetch, api: string, { owner, repo, rest }: RepoRef, log: DeployLog): Promise<Resolved> {
  const repoUrl = `${api}/repos/${owner}/${repo}`;
  const candidates: { ref: string; dir: string[] }[] = [];
  if (rest.length === 0) {
    const info = await getJson(fetcher, repoUrl);
    if (info.status === 404) throw new GitHubError(`${owner}/${repo} が見つかりません（public リポジトリのみ対応しています）`);
    const branch = typeof info.body?.default_branch === "string" ? info.body.default_branch : null;
    if (!branch) throw new GitHubError(`${owner}/${repo} の情報を取得できません（HTTP ${info.status}）`);
    candidates.push({ ref: branch, dir: [] });
  } else {
    for (let i = 1; i <= Math.min(rest.length, 4); i++) candidates.push({ ref: rest.slice(0, i).join("/"), dir: rest.slice(i) });
  }

  for (const c of candidates) {
    const commit = await getJson(fetcher, `${repoUrl}/commits/${encodeURIComponent(c.ref)}`);
    if (commit.body) {
      const detail = commit.body.commit as { message?: string; author?: { name?: string } } | undefined;
      return {
        ...c,
        sha: typeof commit.body.sha === "string" ? commit.body.sha : undefined,
        message: detail?.message?.split("\n")[0],
        author: detail?.author?.name,
      };
    }
    if (commit.status === 409) throw new GitHubError(`${owner}/${repo} は空のリポジトリです（まだ push されていません）`);
    if (commit.status !== 404 && commit.status !== 422) {
      log.add(`コミット情報を取得できませんでした（HTTP ${commit.status}）。${c.ref} をブランチとして扱います`);
      return c;
    }
  }
  throw new GitHubError(`ブランチ ${rest.join("/")} が見つかりません`);
}

async function collect(root: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(path.join(root, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await collect(root, p)));
    else if (entry.isFile()) out.push(p);
  }
  return out;
}

function hint(message: string): string {
  if (/Could not resolve "(?!\.)/.test(message)) return `${message}\nnpm パッケージを使うリポジトリは GitHub Actions でデプロイしてください`;
  return message;
}

export async function deployFromGitHub(input: string, deployer: Deployer, options: GitHubOptions): Promise<DeployResult> {
  const fetcher = options.fetch ?? fetch;
  const api = options.apiBase ?? "https://api.github.com";
  const codeload = options.codeloadBase ?? "https://codeload.github.com";
  const log = new DeployLog(`GitHub からのデプロイを開始しました: ${input}`);
  const buildLog: string[] = [];
  let source: DeploySource = {};
  let name: string | null = null;
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "kanzume-github-"));

  try {
    const repo = parseGitHubUrl(input);
    const resolved = await resolveRef(fetcher, api, repo, log);
    source = {
      repository: `${repo.owner}/${repo.repo}`,
      ref: resolved.ref,
      sha: resolved.sha,
      commitMessage: resolved.message,
      actor: resolved.author,
      serverUrl: "https://github.com",
    };
    const dir = resolved.dir.join("/");
    log.add(`${source.repository}@${resolved.ref}${resolved.sha ? `（${resolved.sha.slice(0, 7)}）` : ""} ${dir ? `の ${dir}/ ` : ""}をダウンロードします`);

    const archive = await download(fetcher, `${codeload}/${repo.owner}/${repo.repo}/tar.gz/${encodeURIComponent(resolved.sha ?? resolved.ref)}`, options.maxBytes);
    if (!archive) throw new GitHubError("リポジトリをダウンロードできません（public リポジトリのみ対応しています）");
    const entries = readTar(gunzipSync(archive, { maxOutputLength: options.maxBytes * 4 }), { skipLinks: true });
    const prefix = dir ? `${dir}/` : "";
    const files = entries
      .map((f) => ({ path: f.path.split("/").slice(1).join("/"), data: f.data }))
      .filter((f) => f.path.startsWith(prefix))
      .map((f) => ({ path: f.path.slice(prefix.length), data: f.data }))
      .filter((f) => f.path && !f.path.startsWith(".git/"));
    log.add(`ダウンロード: ${(archive.length / 1024).toFixed(1)} KiB、${files.length} ファイル`);

    const configFile = CONFIG_FILES.find((c) => files.some((f) => f.path === c));
    if (!configFile) throw new GitHubError(`${dir ? `${dir}/ ` : "リポジトリのトップ"}に ${CONFIG_FILES.join(" / ")} がありません`);
    for (const f of files) {
      const dest = path.join(work, f.path);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, f.data);
    }

    const text = await fs.readFile(path.join(work, configFile), "utf8");
    const config = parseWranglerConfig(configFile, text);
    if (typeof config.name === "string") name = config.name;
    const build = config.build as { command?: string } | undefined;
    if (build?.command) buildLog.push(`build.command（${build.command}）は実行しません。ビルドが必要な場合は GitHub Actions でデプロイしてください`);

    const out: UploadedFile[] = [{ path: configFile, data: Buffer.from(text) }];
    let sources: { path: string; content: string }[] | null = null;

    if (typeof config.main === "string") {
      const { build: esbuild } = await import("esbuild");
      const entry = path.resolve(work, config.main);
      if (!entry.startsWith(work + path.sep)) throw new GitHubError("main のパスが不正です");
      const base = path.basename(config.main).replace(/\.[^.]+$/, "");
      buildLog.push(`$ esbuild ${config.main} --bundle --format=cjs（Kanzume 内でバンドル）`);
      try {
        const result = await esbuild({
          entryPoints: [entry],
          absWorkingDir: work,
          bundle: true,
          format: "cjs",
          platform: "node",
          target: "es2022",
          conditions: ["workerd", "worker", "browser"],
          external: ["cloudflare:*"],
          loader: { ".txt": "text", ".html": "text", ".sql": "text", ".bin": "binary" },
          define: (config.define as Record<string, string>) ?? {},
          alias: (config.alias as Record<string, string>) ?? {},
          write: false,
          metafile: true,
          logLevel: "silent",
          outfile: path.join(work, ".kanzume-out", `${base}.cjs`),
        });
        for (const w of result.warnings) buildLog.push(`▲ ${w.text}`);
        out.push({ path: `worker/${base}.cjs`, data: Buffer.from(result.outputFiles[0].contents) });
        sources = [];
        for (const p of Object.keys(result.metafile.inputs)) {
          if (p.split("/").includes("node_modules")) continue;
          sources.push({ path: p, content: await fs.readFile(path.join(work, p), "utf8") });
        }
        buildLog.push(`バンドルしました: worker/${base}.cjs（${(out[1].data.length / 1024).toFixed(1)} KiB、ソース ${sources.length} ファイル）`);
      } catch (err) {
        const errors = (err as { errors?: { text: string; location?: { file: string; line: number } | null }[] }).errors;
        const message = errors?.length
          ? errors.map((e) => (e.location ? `${e.location.file}:${e.location.line}: ${e.text}` : e.text)).join("\n")
          : (err as Error).message;
        buildLog.push(`✘ ${message}`);
        throw new GitHubError(hint(message));
      }
    }

    const assets = config.assets as { directory?: string } | undefined;
    if (assets?.directory) {
      const assetsRoot = path.resolve(work, assets.directory);
      if (assetsRoot !== work && !assetsRoot.startsWith(work + path.sep)) throw new GitHubError("assets.directory のパスが不正です");
      const exists = await fs.stat(assetsRoot).then((s) => s.isDirectory()).catch(() => false);
      if (!exists) throw new GitHubError(`assets.directory（${assets.directory}）がリポジトリにありません。ビルドが必要なサイトは GitHub Actions でデプロイしてください`);
      const list = (await collect(assetsRoot)).filter((p) => path.basename(p) !== ".assetsignore");
      for (const p of list) out.push({ path: `assets/${p}`, data: await fs.readFile(path.join(assetsRoot, p)) });
      buildLog.push(`アセット: ${assets.directory}（${list.length} ファイル）`);
    }

    return await deployer.deploy({ files: out, sources, source, buildLog: buildLog.join("\n"), log });
  } catch (err) {
    const known = err instanceof GitHubError || err instanceof ConfigError || err instanceof TarError;
    if (!known) console.error("[deploy] GitHub からのデプロイで例外:", err);
    const message = known ? (err as Error).message : `デプロイに失敗しました: ${(err as Error)?.message ?? err}`;
    deployer.recordFailure(name, message, { source, buildLog: buildLog.join("\n"), log });
    return { ok: false, error: message };
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}
