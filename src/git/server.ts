import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { safeEqual, type AdminState, type RepoScope } from "../admin/state.ts";
import type { Config } from "../config.ts";
import { DeployLog, type Deployer } from "../deploy/deployer.ts";
import { deployFromFiles } from "../deploy/github.ts";
import { readTar } from "../deploy/tar.ts";
import { externalOrigin, readBody, sendText } from "../http.ts";
import type { Sites } from "../sites.ts";
import { Repos, ZERO_SHA } from "./repos.ts";

export const GIT_PATH = "/_git";
export const HOOK_PATH = "/_api/git/hook";

// pathname ではなく fileURLToPath にするのは、パスに空白や日本語があると %20 などのままになるため
const HOOK_SCRIPT = fileURLToPath(new URL("./hook.ts", import.meta.url));
const SERVICES: Record<string, RepoScope> = { "git-upload-pack": "read", "git-receive-pack": "write" };

interface Deps {
  config: Config;
  state: AdminState;
  repos: Repos;
  sites: Sites;
  deployer: Deployer;
}

function basicToken(req: IncomingMessage): string {
  const auth = req.headers.authorization ?? "";
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
  if (!auth.startsWith("Basic ")) return "";
  const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
  // ユーザー名は何でもよく、パスワードにトークンを入れる（ユーザー名だけにトークンを入れても通す）
  const i = decoded.indexOf(":");
  return i === -1 ? decoded : decoded.slice(i + 1) || decoded.slice(0, i);
}

/** post-receive フックの置き場所。core.hooksPath で全リポジトリから使う */
export async function installHooks(dataDir: string): Promise<string> {
  const dir = path.join(dataDir, "git-hooks");
  await fs.mkdir(dir, { recursive: true });
  const script = `#!/bin/sh\nexec "${process.execPath}" --disable-warning=ExperimentalWarning "${HOOK_SCRIPT}"\n`;
  await fs.writeFile(path.join(dir, "post-receive"), script, { mode: 0o755 });
  try {
    const exec = execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim();
    if (!existsSync(path.join(exec, "git-http-backend"))) console.warn("[git] git-http-backend がないため、git push を受け付けられません");
  } catch {
    console.warn("[git] git がないため、git push を受け付けられません");
  }
  return dir;
}

function hookHost(address: string | undefined): string {
  if (!address) return "127.0.0.1";
  const v4 = address.replace(/^::ffff:/, "");
  return v4.includes(":") ? `[${v4}]` : v4;
}

export function createGitHandler({ config, state, repos, sites, deployer }: Deps, hooksDir: string) {
  // フックから Kanzume に戻ってくるときの合言葉。起動のたびに変わる
  const hookSecret = randomBytes(24).toString("base64url");
  // push の順番どおりにデプロイするため、リポジトリごとに直列にする
  const queues = new Map<string, Promise<unknown>>();
  const serialize = <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const run = (queues.get(name) ?? Promise.resolve()).then(fn, fn);
    queues.set(name, run.catch(() => {}));
    return run;
  };

  async function handleGit(req: IncomingMessage, res: ServerResponse, pathname: string, search: string): Promise<void> {
    const m = /^\/_git\/([a-z0-9-]+)\.git(\/.*)$/.exec(pathname);
    const query = new URLSearchParams(search.replace(/^\?/, ""));
    const rest = m?.[2] ?? "";
    // Smart HTTP だけを受ける（dumb HTTP でリポジトリの中身をそのまま見せない）
    const service = rest === "/info/refs" ? query.get("service") : rest.slice(1);
    if (!m || !service || !(service in SERVICES)) return sendText(res, 404, "Not Found");
    const name = m[1];

    const access = state.repoAccess(name, basicToken(req));
    if (!access) {
      res.writeHead(401, { "www-authenticate": 'Basic realm="Kanzume"', "content-type": "text/plain; charset=utf-8" });
      res.end("トークンが必要です（パスワードに Token を入力してください）\n");
      return;
    }
    if (SERVICES[service] === "write" && access !== "write") return sendText(res, 403, "このトークンでは push できません（read 専用）\n");
    if (!(await repos.exists(name))) return sendText(res, 404, "リポジトリが見つかりません\n");

    const origin = externalOrigin(req, config.origin);
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: repos.dir,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_PROJECT_ROOT: repos.dir,
      GIT_HTTP_EXPORT_ALL: "1",
      GIT_HTTP_MAX_REQUEST_BUFFER: String(repos.maxInputBytes),
      PATH_INFO: `/${name}.git${rest}`,
      REQUEST_METHOD: req.method ?? "GET",
      QUERY_STRING: search.replace(/^\?/, ""),
      CONTENT_TYPE: req.headers["content-type"] ?? "",
      REMOTE_USER: "kanzume",
      REMOTE_ADDR: req.socket.remoteAddress ?? "",
      // リポジトリの設定ファイルではなく毎回ここで渡すので、KANZUME_MAX_UPLOAD_MB を変えれば既存のリポジトリにも効く
      GIT_CONFIG_COUNT: "4",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: hooksDir,
      GIT_CONFIG_KEY_1: "http.receivepack",
      GIT_CONFIG_VALUE_1: "true",
      GIT_CONFIG_KEY_2: "receive.maxInputSize",
      GIT_CONFIG_VALUE_2: String(repos.maxInputBytes),
      // ブランチの削除は受け付けない（main を消すとデプロイ元がなくなるため）
      GIT_CONFIG_KEY_3: "receive.denyDeletes",
      GIT_CONFIG_VALUE_3: "true",
      // フックに渡す情報。戻り先は、この接続を受けたアドレス（待ち受けているアドレス）にする
      KANZUME_HOOK_URL: `http://${hookHost(req.socket.localAddress)}:${req.socket.localPort}${HOOK_PATH}`,
      KANZUME_HOOK_SECRET: hookSecret,
      KANZUME_REPO: name,
      KANZUME_ORIGIN_URL: origin,
    };
    if (req.headers["content-encoding"]) env.HTTP_CONTENT_ENCODING = String(req.headers["content-encoding"]);
    if (req.headers["git-protocol"]) env.GIT_PROTOCOL = String(req.headers["git-protocol"]);

    const child = spawn("git", ["http-backend"], { env, stdio: ["pipe", "pipe", "pipe"] });
    let received = 0;
    req.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > repos.maxInputBytes) {
        child.kill();
        req.destroy();
      }
    });
    req.pipe(child.stdin);
    child.stdin.on("error", () => {});
    child.stderr.on("data", (d: Buffer) => console.error(`[git] ${d.toString().trimEnd()}`));

    await new Promise<void>((resolve) => {
      let head = Buffer.alloc(0);
      let headersSent = false;
      child.stdout.on("data", (chunk: Buffer) => {
        if (headersSent) {
          res.write(chunk);
          return;
        }
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf("\r\n\r\n") !== -1 ? head.indexOf("\r\n\r\n") + 4 : head.indexOf("\n\n") !== -1 ? head.indexOf("\n\n") + 2 : -1;
        if (end === -1) return;
        let status = 200;
        const headers: Record<string, string> = { "cache-control": "no-store" };
        for (const line of head.subarray(0, end).toString("latin1").split(/\r?\n/)) {
          const i = line.indexOf(":");
          if (i === -1) continue;
          const key = line.slice(0, i).trim().toLowerCase();
          const value = line.slice(i + 1).trim();
          if (key === "status") status = Number.parseInt(value, 10) || 200;
          else headers[key] = value;
        }
        res.writeHead(status, headers);
        headersSent = true;
        res.write(head.subarray(end));
      });
      child.on("close", (code) => {
        if (!headersSent) {
          if (received > repos.maxInputBytes) sendText(res, 413, `push は ${Math.round(repos.maxInputBytes / 1024 / 1024)} MB までです\n`);
          else sendText(res, 500, `git http-backend が失敗しました（終了コード ${code}）\n`);
        } else {
          res.end();
        }
        resolve();
      });
      child.on("error", (err) => {
        console.error("[git] git http-backend を起動できません:", err);
        if (!headersSent) sendText(res, 500, "サーバーに git がありません\n");
        resolve();
      });
    });
  }

  /** post-receive フックから呼ばれる。デフォルトブランチへの push ならデプロイし、ログを 1 行ずつ返す */
  async function handleHook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST" || !safeEqual(String(req.headers["x-kanzume-hook"] ?? ""), hookSecret)) return sendText(res, 403, "Forbidden");
    const raw = await readBody(req, 1024 * 1024);
    let body: { repo?: string; origin?: string; updates?: { old: string; new: string; ref: string }[] };
    try {
      body = JSON.parse(raw?.toString("utf8") ?? "");
    } catch {
      return sendText(res, 400, "Bad Request");
    }
    const name = String(body.repo ?? "");
    if (!(await repos.exists(name))) return sendText(res, 404, "Not Found");

    res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    const say = (line: string) => res.write(`${line}\n`);
    try {
      const branch = await repos.defaultBranch(name);
      const update = (body.updates ?? []).find((u) => u.ref === `refs/heads/${branch}` && u.new !== ZERO_SHA);
      if (!update) {
        say(`${branch} 以外への push なので、保存だけしてデプロイはしません`);
        return;
      }
      const result = await serialize(name, async () => {
        // 待っている間に新しい push があれば、古いコミットはデプロイしない
        if ((await repos.resolve(name, `refs/heads/${branch}`)) !== update.new) return null;
        const commit = await repos.commit(name, update.new);
        const log = new DeployLog(`git push（${name}@${branch} ${commit.sha.slice(0, 7)}）からデプロイします`, say);
        const files = readTar(await repos.archive(name, update.new), { skipLinks: true }).filter((f) => f.path && !f.path.startsWith(".git/"));
        log.add(`ファイル: ${files.length} 件`);
        return deployFromFiles(files, deployer, {
          source: { repository: name, ref: branch, sha: commit.sha, commitMessage: commit.subject, actor: commit.author },
          log,
          buildLog: [],
          expectedName: name,
        });
      });
      if (!result) {
        say(`${branch} に新しい push があるので、このコミットのデプロイは飛ばします`);
      } else if (result.ok) {
        const site = result.release.manifest.name;
        say(`デプロイしました: ${sites.urls(String(body.origin || externalOrigin(req, config.origin)), site).url}`);
      } else {
        say(`デプロイに失敗しました: ${result.error}`);
        say("（push したコミットは保存されています。直して push し直してください）");
      }
    } catch (err) {
      console.error("[git] push 後のデプロイで例外:", err);
      say(`デプロイに失敗しました: ${(err as Error).message}`);
    } finally {
      res.end();
    }
  }

  return { handleGit, handleHook };
}
