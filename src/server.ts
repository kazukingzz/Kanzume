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
import { closeAllSiteDbs } from "./bindings/db.ts";

export async function createServer(config: Config, options: { github?: Partial<GitHubOptions> } = {}) {
  const sites = new Sites(config.dataDir);
  await sites.init();
  const state = new AdminState(config.dataDir);
  await state.init();
  const runtime = new Runtime({ idleMs: config.workerIdleMs, cpuTimeoutMs: config.cpuTimeoutMs, maxWorkers: config.maxWorkers });

  const metaDb = openMetaDb(config.dataDir);
  const history = new DeployHistory(metaDb);
  const observability = new Observability(metaDb, config.logRetentionHours);
  const resources = new ResourceMonitor();

  const deployer = new Deployer(sites, runtime, history);
  const deps = { config, state, sites, runtime, history, observability, resources, deployer, github: options.github };
  const { handleDeploy, handleReport } = createDeployHandler(deps);
  const handle = createRouter({
    ...deps,
    handleAdmin: createAdminHandler(deps),
    handleDeploy,
    handleReport,
  });

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
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
    runtime.close();
    observability.close();
    resources.close();
    metaDb.close();
    closeAllSiteDbs();
  });
  return { server, sites, state, runtime, history, observability, resources, deployer };
}

if (import.meta.main) {
  const config = loadConfig();
  const { server } = await createServer(config);
  server.listen(config.port, () => {
    console.log(`[kanzume] listening on :${config.port} (data: ${config.dataDir})`);
    console.log(`[kanzume] 管理画面: ${config.publicUrl ?? `http://localhost:${config.port}`}${ADMIN_PATH}`);
    if (config.setupTokenGenerated) console.log(`[kanzume] セットアップトークン: ${config.setupToken}`);
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 5000).unref();
    });
  }
}
