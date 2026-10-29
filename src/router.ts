import type { IncomingMessage, ServerResponse } from "node:http";
import { ADMIN_PATH } from "./admin/handler.ts";
import { matchAsset, notFoundAsset, serveAssets } from "./bindings/assets.ts";
import type { Config } from "./config.ts";
import { clientIp, externalOrigin, sendText, sendWebResponse, toWebRequest } from "./http.ts";
import { Invocation, runInvocation, type Observability } from "./observability/events.ts";
import type { Runtime } from "./runtime/runtime.ts";
import type { Release, Store } from "./store.ts";

interface Deps {
  config: Config;
  store: Store;
  runtime: Runtime;
  handleAdmin(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void>;
  handleDeploy(req: IncomingMessage, res: ServerResponse): Promise<void>;
  handleReport(req: IncomingMessage, res: ServerResponse): Promise<void>;
  observability: Observability;
}

const WAIT_UNTIL_LIMIT_MS = 30_000;

const EMPTY = `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Kanzume</title>
<body style="font-family:system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;color:#1d1d1b;background:#f6f6f4">
<main style="padding:16px;text-align:center"><h1 style="font-size:20px">Kanzume</h1><p>まだサイトがデプロイされていません。</p><p><a href="${ADMIN_PATH}" style="color:#c2410c">管理画面を開く</a></p></main></body></html>`;

export function globToRegExp(pattern: string): RegExp {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`);
}

export function runWorkerFirst(rule: boolean | string[], pathname: string): boolean {
  if (typeof rule === "boolean") return rule;
  let matched = false;
  for (const pattern of rule) {
    if (pattern.startsWith("!")) {
      if (globToRegExp(pattern.slice(1)).test(pathname)) return false;
    } else if (globToRegExp(pattern).test(pathname)) {
      matched = true;
    }
  }
  return matched;
}

function workerFailure(release: Release, error: unknown): Response {
  console.error(`[${release.manifest.name}] Worker で例外:`, error);
  return new Response("Worker threw exception", { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } });
}

export function createRouter({ config, store, runtime, handleAdmin, handleDeploy, handleReport, observability }: Deps) {
  async function handleSite(req: IncomingMessage, res: ServerResponse, release: Release, pathname: string, search: string) {
    const request = toWebRequest(req, `${externalOrigin(req, config.origin)}${pathname}${search}`, { "cf-connecting-ip": clientIp(req) });
    const invocation = new Invocation(release.manifest.name, release.id, request, `${pathname}${search}`);
    let waitUntil: Promise<unknown>[] = [];

    const response = await runInvocation(invocation, async () => {
      const { manifest } = release;
      if (!manifest.main) return serveAssets(release, request);
      if (manifest.assets && !runWorkerFirst(manifest.assets.runWorkerFirst, pathname)) {
        const asset = await matchAsset(release, request);
        if (asset) return asset;
        if (manifest.assets.notFoundHandling === "single-page-application" && request.headers.get("sec-fetch-mode") === "navigate") {
          const spa = await notFoundAsset(release, request);
          if (spa) return spa;
        }
      }
      invocation.kind = "worker";
      try {
        const worker = await runtime.get(release);
        const result = await worker.fetch(request);
        waitUntil = result.waitUntil;
        if (result.response) return result.response;
        invocation.exception(result.error);
        invocation.outcome = /Script execution timed out/.test(String((result.error as Error)?.message ?? result.error)) ? "exceededCpu" : "exception";
        if (result.passThrough) return serveAssets(release, request);
        return workerFailure(release, result.error);
      } catch (err) {
        invocation.exception(err);
        invocation.outcome = "exception";
        return workerFailure(release, err);
      }
    });

    invocation.response(response);
    await sendWebResponse(res, response, req.method);
    if (!res.writableFinished && invocation.outcome === "ok") invocation.outcome = "canceled";

    const status = response.status;
    const duration = performance.now() - invocation.startedAt;
    if (waitUntil.length) {
      const limit = new Promise((resolve) => setTimeout(resolve, WAIT_UNTIL_LIMIT_MS).unref());
      void Promise.race([Promise.allSettled(waitUntil), limit]).then(() => observability.record(invocation, status, duration));
    } else {
      observability.record(invocation, status, duration);
    }
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = req.url ?? "/";
    const q = raw.indexOf("?");
    const pathname = q === -1 ? raw : raw.slice(0, q);
    const search = q === -1 ? "" : raw.slice(q);

    if (pathname === "/_health") return sendText(res, 200, "ok");
    if (pathname === "/_api/deploy") return handleDeploy(req, res);
    if (pathname === "/_api/deploy/report") return handleReport(req, res);
    if (pathname === ADMIN_PATH || pathname.startsWith(`${ADMIN_PATH}/`)) return handleAdmin(req, res, pathname);
    if (pathname.startsWith("/_api/")) return sendText(res, 404, "Not Found");

    const release = store.get();
    if (!release) {
      if (pathname !== "/") return sendText(res, 404, "Not Found");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(EMPTY);
      return;
    }
    await handleSite(req, res, release, pathname, search);
  };
}
