import http from "node:http";
import { createAdminHandler, ADMIN_PATH } from "./admin/handler.ts";
import { AdminState } from "./admin/state.ts";
import { loadConfig, type Config } from "./config.ts";
import { Deployer } from "./deploy/deployer.ts";
import type { GitHubOptions } from "./deploy/github.ts";
import { createDeployHandler } from "./deploy/handler.ts";
import { DeployHistory } from "./deploy/history.ts";
import { openMetaDb } from "./observability/db.ts";
import { Observability } from "./observability/events.ts";
import { ResourceMonitor } from "./observability/resources.ts";
import { createRouter } from "./router.ts";
import { Runtime } from "./runtime/runtime.ts";
import { Sites } from "./sites.ts";
import { Repos } from "./git/repos.ts";
import { createGitHandler, installHooks } from "./git/server.ts";
import { closeAllSiteDbs } from "./bindings/db.ts";
import fs from "node:fs/promises";
import path from "node:path";
import { isRoot, prepareSiteDir, siteUid } from "./runtime/process.ts";
import { Backup, restoreOnBoot } from "./backup/backup.ts";
import { BackupUrlError } from "./backup/url.ts";

/**
 * Worker の子プロセス（サイトごとの別ユーザー）から、本体のデータが見えないようにする。
 * 本体が作るファイルは本人とグループだけが読み書きできるようにし（umask 007）、/data の直下は一覧を見せない
 */
/** 本体が作るファイルを、ほかのユーザー（Worker の子プロセス）から見えないようにする。復元より前に呼ぶ */
function applyUmask(config: Config): void {
  if (config.isolation === "process" && isRoot()) process.umask(0o007);
}

async function protectDataDir(dataDir: string, sites: Sites): Promise<void> {
  if (!isRoot()) {
    console.warn(
      "[kanzume] root で動いていないので、Worker の子プロセスを別のユーザーに分けられません。Node の権限モデルだけで制限しますが、" +
        "Worker が node:vm から抜け出すと、同じユーザーで動く本体やほかのサイトのデータに届きます（本番は Docker イメージのように root で動かしてください）",
    );
    return;
  }
  process.umask(0o007);
  await fs.mkdir(path.join(dataDir, "sites"), { recursive: true });
  await fs.chmod(dataDir, 0o711);
  await fs.chmod(path.join(dataDir, "sites"), 0o711);
  for (const name of ["admin.json", "meta.sqlite", "meta.sqlite-wal", "meta.sqlite-shm", "sites/_root", "sites/_uids.json"]) {
    await fs.chmod(path.join(dataDir, name), 0o600).catch(() => {});
  }
  for (const name of ["repos", "git-hooks"]) await fs.chmod(path.join(dataDir, name), 0o700).catch(() => {});
  // 全サイトの所有者とモードを、起動のたびにそろえる（以前のバージョンのデータや、バックアップから戻したデータも直す）
  // 1 つのサイトで失敗しても（置き換えられた data など）、ほかのサイトと本体は起動する
  const prepare = (name: string, siteDir: string) => {
    try {
      prepareSiteDir(siteDir, siteUid(dataDir, name));
    } catch (err) {
      console.error(`[kanzume] サイト ${name} の権限をそろえられませんでした:`, (err as Error)?.message ?? err);
    }
  };
  for (const { name, store } of sites.list()) prepare(name, store.siteDir);
  // あとから作るサイトは、作った時点でそろえる
  sites.onCreate = prepare;
}

export async function createServer(config: Config, options: { github?: Partial<GitHubOptions>; backup?: Backup | null } = {}) {
  applyUmask(config);
  const sites = new Sites(config.dataDir);
  await sites.init();
  const state = new AdminState(config.dataDir);
  await state.init();
  if (config.isolation === "process") await protectDataDir(config.dataDir, sites);
  const runtime = new Runtime({ idleMs: config.workerIdleMs, cpuTimeoutMs: config.cpuTimeoutMs, maxWorkers: config.maxWorkers, isolation: config.isolation, dataDir: config.dataDir });

  const metaDb = openMetaDb(config.dataDir);
  const history = new DeployHistory(metaDb);
  const observability = new Observability(metaDb, config.logRetentionHours);
  const resources = new ResourceMonitor();

  const deployer = new Deployer(sites, runtime, history);
  const repos = new Repos(config.dataDir, config.maxUploadBytes, config.repoQuotaBytes);
  await repos.init();
  // リポジトリはサイトに属する。サイトのないリポジトリ（サイトに紐づける前に作ったもの）には、同じ名前の空のサイトを作る
  for (const name of await repos.names()) {
    if (sites.has(name)) continue;
    try {
      await sites.ensure(name);
      console.log(`[kanzume] リポジトリ ${name} に合わせて、未デプロイのサイト ${name} を作りました`);
    } catch (err) {
      console.error(`[kanzume] リポジトリ ${name} のサイトを作れません: ${(err as Error)?.message ?? err}`);
    }
  }
  const { handleGit, handleHook } = createGitHandler({ config, state, repos, sites, deployer }, await installHooks(config.dataDir));
  const backup = options.backup ?? null;
  if (backup) {
    backup.attachMetaDb(metaDb);
    const soon = () => backup.requestSoon();
    state.onChange = sites.onChange = repos.onChange = deployer.onChange = soon;
    backup.start();
  }
  const deps = { config, state, sites, repos, runtime, history, observability, resources, deployer, backup, github: options.github };
  const { handleDeploy, handleReport } = createDeployHandler(deps);
  const handle = createRouter({
    ...deps,
    handleAdmin: createAdminHandler(deps),
    handleDeploy,
    handleReport,
    handleGit,
    handleHook,
  });

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      // パスの %xx が壊れているなど（decodeURIComponent の URIError）は、利用者の入力の誤り
      if (err instanceof URIError && !res.headersSent) {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        res.end("Bad Request");
        return;
      }
      console.error("[kanzume] リクエスト処理で例外:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end("Internal Server Error");
      } else {
        res.destroy();
      }
    });
  });
  server.on("close", () => {
    backup?.stop();
    runtime.close();
    observability.close();
    resources.close();
    metaDb.close();
    closeAllSiteDbs();
  });
  return { server, sites, repos, state, runtime, history, observability, resources, deployer, backup };
}

/**
 * 起動の準備。バックアップが設定されていて /data が空なら、外部の最新世代を復元する。
 * HTTP サーバーはこれが終わってから始める（途中でリクエストを受けると、初期セットアップの画面が出たり空の状態をバックアップしたりするため）
 */
export async function prepareBackup(config: Config): Promise<Backup | null> {
  applyUmask(config);
  if (!config.backup) {
    console.log("[backup] KANZUME_BACKUP_URL が未設定なので、バックアップしません");
    return null;
  }
  const backup = new Backup(config.backup, config.dataDir);
  await restoreOnBoot(backup);
  return backup;
}

if (import.meta.main) {
  let config: Config;
  let backup: Backup | null;
  try {
    config = loadConfig();
    backup = await prepareBackup(config);
  } catch (err) {
    // URL や認証情報はメッセージに含めない
    console.error(`[kanzume] 起動できません: ${err instanceof BackupUrlError ? err.message : ((err as Error)?.message ?? err)}`);
    process.exit(1);
  }
  const { server } = await createServer(config, { backup });
  server.listen(config.port, () => {
    console.log(`[kanzume] listening on :${config.port} (data: ${config.dataDir})`);
    console.log(`[kanzume] 管理画面: ${config.publicUrl ?? `http://localhost:${config.port}`}${ADMIN_PATH}`);
    if (config.setupTokenGenerated) console.log(`[kanzume] セットアップトークン: ${config.setupToken}`);
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, async () => {
      setTimeout(() => process.exit(0), 8000).unref();
      // 止まる前に、最後の変更を送っておく（間に合わなければあきらめる）
      if (backup) await Promise.race([backup.backupNow("停止").catch(() => {}), new Promise((r) => setTimeout(r, 6000))]);
      server.close(() => process.exit(0));
    });
  }
}
