import { UserFacingError } from "../errors.ts";
import type { UploadedFile } from "../store.ts";
import { deployFromFiles, recordBuildFailure } from "./build.ts";
import { DeployLog, type Deployer, type DeployResult } from "./deployer.ts";
import type { DeploySource } from "./history.ts";
import { extractTarGz } from "./tar.ts";
import { CONFIG_FILES, parseWranglerConfig } from "./wrangler.ts";

export interface GitHubOptions {
  fetch?: typeof fetch;
  apiBase?: string;
  codeloadBase?: string;
  maxBytes: number;
}

/** GitHub からの取得の失敗（URL の誤り・見つからない・大きすぎるなど） */
export class GitHubError extends UserFacingError {}

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

export interface Fetched {
  source: DeploySource;
  /** リポジトリの中のディレクトリ（トップなら ""） */
  dir: string;
  files: UploadedFile[];
}

/** GitHub の URL のリポジトリ（ディレクトリ）をダウンロードして、ファイルの一覧にする */
export async function fetchFromGitHub(input: string, options: GitHubOptions, log: DeployLog): Promise<Fetched> {
  const fetcher = options.fetch ?? fetch;
  const api = options.apiBase ?? "https://api.github.com";
  const codeload = options.codeloadBase ?? "https://codeload.github.com";
  const repo = parseGitHubUrl(input);
  const resolved = await resolveRef(fetcher, api, repo, log);
  const source: DeploySource = {
    repository: `${repo.owner}/${repo.repo}`,
    ref: resolved.ref,
    sha: resolved.sha,
    commitMessage: resolved.message,
    actor: resolved.author,
    serverUrl: "https://github.com",
  };
  const dir = resolved.dir.join("/");
  log.add(`${source.repository}@${resolved.ref}${resolved.sha ? `（${resolved.sha.slice(0, 7)}）` : ""} ${dir ? `の ${dir}/ ` : ""}をダウンロードします`);

  const archive = await download(
    fetcher,
    `${codeload}/${repo.owner}/${repo.repo}/tar.gz/${encodeURIComponent(resolved.sha ?? resolved.ref)}`,
    options.maxBytes,
  );
  if (!archive) throw new GitHubError("リポジトリをダウンロードできません（public リポジトリのみ対応しています）");
  const entries = extractTarGz(archive, options.maxBytes, { skipLinks: true });
  const prefix = dir ? `${dir}/` : "";
  const files = entries
    .map((f) => ({ path: f.path.split("/").slice(1).join("/"), data: f.data }))
    .filter((f) => f.path.startsWith(prefix))
    .map((f) => ({ path: f.path.slice(prefix.length), data: f.data }))
    .filter((f) => f.path && !f.path.startsWith(".git/"));
  log.add(`ダウンロード: ${(archive.length / 1024).toFixed(1)} KiB、${files.length} ファイル`);
  return { source, dir, files };
}

export interface Inspection {
  vars: Record<string, string>;
}

/** デプロイ前の設定画面のために、wrangler の設定から vars を読む（name は使わない。デプロイ先は選んだサイト） */
export function inspectFiles(fetched: Fetched): Inspection {
  let config: Record<string, unknown> | null = null;
  for (const c of CONFIG_FILES) {
    const f = fetched.files.find((x) => x.path === c);
    if (f) {
      config = parseWranglerConfig(c, f.data.toString("utf8"));
      break;
    }
  }
  if (!config) throw new GitHubError(`${fetched.dir ? `${fetched.dir}/ ` : "リポジトリのトップ"}に ${CONFIG_FILES.join(" / ")} がありません`);
  const vars: Record<string, string> = {};
  if (config.vars && typeof config.vars === "object") {
    // 文字列でない値（JSON）は wrangler の設定のまま使うので、編集できる初期値には入れない
    for (const [k, v] of Object.entries(config.vars as Record<string, unknown>)) if (typeof v === "string") vars[k] = v;
  }
  return { vars };
}

/** autoRoot: ルートのサイトがまだないとき、このサイトをルートにしてよいか（管理者のときだけ。ルートは管理画面と同じオリジンになるため） */
export async function deployFromGitHub(
  input: string,
  deployer: Deployer,
  options: GitHubOptions & { siteName: string; autoRoot?: boolean },
): Promise<DeployResult> {
  const log = new DeployLog(`GitHub からのデプロイを開始しました: ${input}`);
  let fetched: Fetched;
  try {
    fetched = await fetchFromGitHub(input, options, log);
  } catch (err) {
    return recordBuildFailure(deployer, err, { source: {}, buildLog: [], log, siteName: options.siteName }, "GitHub からのデプロイ");
  }
  const { source, dir, files } = fetched;
  return deployFromFiles(files, deployer, {
    source,
    log,
    buildLog: [],
    where: dir ? `${dir}/ ` : "リポジトリのトップ",
    autoRoot: options.autoRoot ?? false,
    siteName: options.siteName,
  });
}
