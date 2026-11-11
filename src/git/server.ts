import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { safeEqual, type AdminState } from "../admin/state.ts";
import type { Config } from "../config.ts";
import { BuildError, deployFromDirectory } from "../deploy/build.ts";
import { DeployLog, type Deployer } from "../deploy/deployer.ts";
import { EXTRACT_RATIO } from "../deploy/tar.ts";
import { findConfigFile } from "../deploy/wrangler.ts";
import { mib, UserFacingError } from "../errors.ts";
import { readJson, requestToken, rootOrigin, sendText } from "../http.ts";
import type { Sites } from "../sites.ts";
import type { Repos } from "./repos.ts";

export const GIT_PATH = "/_git";
export const HOOK_PATH = "/_api/git/hook";

const HOOKS = { "post-receive": "hook.ts", "pre-receive": "pre-receive.ts" };
/** clone / fetch と push。どちらも、そのサイトを扱えるユーザーの個人トークンで使える */
const SERVICES = new Set(["git-upload-pack", "git-receive-pack"]);

interface Deps {
  config: Config;
  state: AdminState;
  repos: Repos;
  sites: Sites;
  deployer: Deployer;
}

/** sh の単一引用符で囲む（パスに " $ ` \ があっても展開させない） */
const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** フックの置き場所。core.hooksPath で全リポジトリから使う */
export async function installHooks(dataDir: string): Promise<string> {
  const dir = path.join(dataDir, "git-hooks");
  await fs.mkdir(dir, { recursive: true });
  for (const [hook, file] of Object.entries(HOOKS)) {
    const script = `#!/bin/sh\nexec ${shQuote(process.execPath)} --disable-warning=ExperimentalWarning ${shQuote(path.join(import.meta.dirname, file))}\n`;
    await fs.writeFile(path.join(dir, hook), script, { mode: 0o755 });
  }
  try {
    const exec = execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim();
    if (!existsSync(path.join(exec, "git-http-backend"))) console.warn("[git] git-http-backend がないため、git push を受け付けられません");
  } catch {
    console.warn("[git] git がないため、git push を受け付けられません");
  }
  return dir;
}

/** GIT_CONFIG_COUNT / KEY_n / VALUE_n を組み立てる（番号を手で振らない） */
function gitConfigEnv(entries: [string, string][]): Record<string, string> {
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(entries.length) };
  entries.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

export function createGitHandler({ config, state, repos, sites, deployer }: Deps, hooksDir: string) {
  // フックから Kanzume に戻ってくるときの合言葉。起動のたびに変わる
  const hookSecret = randomBytes(24).toString("base64url");

  async function handleGit(req: IncomingMessage, res: ServerResponse, pathname: string, search: string): Promise<void> {
    const m = /^\/_git\/([a-z0-9-]+)\.git(\/.*)$/.exec(pathname);
    const rest = m?.[2] ?? "";
    let service: string | null;
    if (rest === "/info/refs") {
      // service を複数付けられると、確認した値と http-backend が使う値が食い違うので 1 つだけ受ける
      const values = new URLSearchParams(search.replace(/^\?/, "")).getAll("service");
      service = values.length === 1 ? values[0] : null;
    } else {
      service = rest.slice(1);
    }
    // Smart HTTP だけを受ける（dumb HTTP でリポジトリの中身をそのまま見せない）
    if (!m || !service || !SERVICES.has(service)) return sendText(res, 404, "Not Found");
    const name = m[1];

    const token = requestToken(req);
    if (!state.repoAccess(name, token)) {
      res.writeHead(401, { "www-authenticate": 'Basic realm="Kanzume"', "content-type": "text/plain; charset=utf-8" });
      res.end("トークンが必要です（パスワードに、管理画面の「設定 > トークン」で発行した個人トークンを入力してください）\n");
      return;
    }
    if (!(await repos.exists(name))) return sendText(res, 404, "リポジトリが見つかりません\n");

    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: repos.dir,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_PROJECT_ROOT: repos.dir,
      GIT_HTTP_EXPORT_ALL: "1",
      GIT_HTTP_MAX_REQUEST_BUFFER: String(repos.maxInputBytes),
      PATH_INFO: `/${name}.git${rest}`,
      REQUEST_METHOD: req.method ?? "GET",
      QUERY_STRING: rest === "/info/refs" ? `service=${service}` : "",
      CONTENT_TYPE: req.headers["content-type"] ?? "",
      REMOTE_USER: "kanzume",
      REMOTE_ADDR: req.socket.remoteAddress ?? "",
      // リポジトリの設定ファイルではなく毎回ここで渡すので、設定を変えれば既存のリポジトリにも効く
      ...gitConfigEnv([
        ["core.hooksPath", hooksDir],
        ["http.receivepack", "true"],
        ["receive.maxInputSize", String(repos.maxInputBytes)],
      ]),
      // フックに渡す情報。戻り先はループバック（listen() はすべてのアドレスで待ち受けている）
      KANZUME_HOOK_URL: `http://127.0.0.1:${req.socket.localPort}${HOOK_PATH}`,
      KANZUME_HOOK_SECRET: hookSecret,
      KANZUME_REPO: name,
      KANZUME_ORIGIN_URL: rootOrigin(req, config.origin, state.domain),
      // 管理者の個人トークンでの push かどうか（メンバーのトークンでは、最初のサイトをルートにしない）
      KANZUME_PUSH_SCOPE: state.deployAccess(token)?.autoRoot ? "global" : "repo",
      KANZUME_REPO_QUOTA_BYTES: String(repos.quotaBytes),
    };
    if (req.headers["content-encoding"]) env.HTTP_CONTENT_ENCODING = String(req.headers["content-encoding"]);
    if (req.headers["git-protocol"]) env.GIT_PROTOCOL = String(req.headers["git-protocol"]);

    const fail = (status: number, message: string) => {
      if (!res.headersSent) sendText(res, status, message);
      else res.destroy();
    };

    const child = spawn("git", ["http-backend"], { env, stdio: ["pipe", "pipe", "pipe"] });
    if (!child.stdin || !child.stdout || !child.stderr) {
      // EMFILE などで子プロセスの stdio を作れなかった
      child.on("error", () => {});
      return fail(500, "git を起動できませんでした\n");
    }
    const { stdin, stdout, stderr } = child;

    // 途中で切れたら git も止める（止めないと stdin を待ったまま残り続ける）
    let tooLarge = false;
    const kill = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    };
    req.on("close", () => {
      if (!req.complete) kill();
    });
    res.on("close", () => {
      if (!res.writableFinished) kill();
    });
    let received = 0;
    req.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > repos.maxInputBytes) {
        tooLarge = true;
        kill();
        req.destroy();
      }
    });
    pipeline(req, stdin).catch(() => {});
    stderr.on("data", (d: Buffer) => console.error(`[git] ${d.toString().trimEnd()}`));

    await new Promise<void>((resolve) => {
      let head: Buffer | null = Buffer.alloc(0);
      const write = (chunk: Buffer) => {
        // 受け手が遅いときは git の出力を止めて、メモリに溜め込まない
        if (!res.write(chunk)) {
          stdout.pause();
          res.once("drain", () => stdout.resume());
        }
      };
      stdout.on("data", (chunk: Buffer) => {
        if (head === null) return write(chunk);
        head = Buffer.concat([head, chunk]);
        const crlf = head.indexOf("\r\n\r\n");
        const lf = head.indexOf("\n\n");
        const end = crlf !== -1 ? crlf + 4 : lf !== -1 ? lf + 2 : -1;
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
        const body = head.subarray(end);
        head = null;
        res.writeHead(status, headers);
        write(body);
      });
      // 応答は close でだけ返す（error のあとにも close は来るので、ここで二重に返さない）
      let spawnError: Error | null = null;
      child.on("error", (err) => {
        spawnError = err;
        console.error("[git] git http-backend を起動できません:", err);
      });
      child.on("close", (code) => {
        if (res.headersSent) res.end();
        else if (tooLarge) fail(413, `push は ${mib(repos.maxInputBytes)} までです\n`);
        else if (spawnError) fail(500, "サーバーで git を起動できませんでした\n");
        else fail(500, `git http-backend が失敗しました（終了コード ${code}）\n`);
        resolve();
      });
    });
  }

  /** post-receive フックから呼ばれる。デフォルトブランチへの push ならデプロイし、ログを 1 行ずつ返す */
  async function handleHook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST" || !safeEqual(String(req.headers["x-kanzume-hook"] ?? ""), hookSecret)) return sendText(res, 403, "Forbidden");
    const body = (await readJson(req, 1024 * 1024)) as {
      repo?: string;
      origin?: string;
      scope?: string;
      updates?: { old: string; new: string; ref: string }[];
    } | null;
    if (!body) return sendText(res, 400, "Bad Request");
    const name = String(body.repo ?? "");
    if (!(await repos.exists(name))) return sendText(res, 404, "Not Found");

    res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    const say = (line: string) => res.write(`${line}\n`);
    try {
      const branch = await repos.defaultBranch(name);
      const update = (body.updates ?? []).find((u) => u.ref === `refs/heads/${branch}`);
      if (!update) {
        say(`${branch} 以外への push なので、保存だけしてデプロイはしません`);
        return;
      }
      // すぐに 1 行返してヘッダーを送る（前のデプロイを待つ間に、フック側の待ち時間の上限に当たらないように）
      say("デプロイの順番を待っています…");
      // push の順番どおりにデプロイするため、サイトごとに直列にする（ファイルのアップロードとも）
      await deployer.exclusive(name, async () => {
        const log = new DeployLog(`git push（${name}@${branch} ${update.new.slice(0, 7)}）からデプロイします`, say);
        const source = { repository: name, ref: branch, sha: update.new };
        try {
          // 待っている間に新しい push があれば、古いコミットはデプロイしない
          const head = await repos.commit(name, `refs/heads/${branch}`);
          if (head.sha !== update.new) {
            say(`${branch} に新しい push（${head.sha.slice(0, 7)}）があるので、このコミットのデプロイは飛ばします`);
            return;
          }
          Object.assign(source, { commitMessage: head.subject, actor: head.author });

          // 取り出す前に、設定があるかと大きさだけを確かめる（デプロイできない push で全体を書き出さない）。
          // リポジトリはサイトのものなので、wrangler の name にかかわらずこのサイトにデプロイする
          await findConfigFile(async (c) => (await repos.readFile(name, head.sha, c)) !== null, "リポジトリのトップ");
          const size = await repos.treeSize(name, head.sha);
          const limit = config.maxUploadBytes * EXTRACT_RATIO;
          if (size > limit) throw new BuildError(`ファイルの合計（${mib(size)}）が上限（${mib(limit)}）を超えています`);

          const work = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "kanzume-push-")));
          try {
            await repos.checkout(name, head.sha, work);
            log.add(`取り出し: ${(size / 1024).toFixed(1)} KiB`);
            const result = await deployFromDirectory(work, deployer, {
              source,
              log,
              buildLog: [],
              siteName: name,
              autoRoot: body.scope === "global",
            });
            if (result.ok) {
              let url = "";
              try {
                url = sites.urls(String(body.origin || rootOrigin(req, config.origin, state.domain)), name).url;
              } catch {
                // オリジンが壊れていても、デプロイ自体は成功している
              }
              say(`デプロイしました${url ? `: ${url}` : ""}`);
            } else {
              say(`デプロイに失敗しました: ${result.error}`);
              say("（push したコミットは保存されています。直して push し直してください）");
            }
          } finally {
            await fs.rm(work, { recursive: true, force: true });
          }
        } catch (err) {
          const known = err instanceof UserFacingError;
          if (!known) console.error("[git] push 後のデプロイで例外:", err);
          const message = known ? (err as Error).message : `デプロイに失敗しました: ${(err as Error).message}`;
          // 取り出しの前に失敗しても、リポジトリ名の履歴に残す
          deployer.recordFailure(name, message, { source, buildLog: "", log });
          say(`デプロイに失敗しました: ${message}`);
        }
      });
    } catch (err) {
      console.error("[git] push 後の処理で例外:", err);
      say(`デプロイに失敗しました: ${(err as Error).message}`);
    } finally {
      res.end();
    }
  }

  return { handleGit, handleHook };
}
