import type { IncomingMessage, ServerResponse } from "node:http";
import { ADMIN_PATH } from "./admin/handler.ts";
import { matchAsset, notFoundAsset, serveAssets } from "./bindings/assets.ts";
import type { Config } from "./config.ts";
import { clientIp, requestOrigin, sendText, sendWebResponse, toWebRequest } from "./http.ts";
import { Invocation, runInvocation, type Observability } from "./observability/events.ts";
import type { Runtime } from "./runtime/runtime.ts";
import { GIT_PATH, HOOK_PATH } from "./git/server.ts";
import { matchHost, parentHost, type Sites } from "./sites.ts";
import type { Release } from "./store.ts";

interface Deps {
  config: Config;
  sites: Sites;
  runtime: Runtime;
  handleAdmin(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void>;
  handleDeploy(req: IncomingMessage, res: ServerResponse): Promise<void>;
  handleReport(req: IncomingMessage, res: ServerResponse): Promise<void>;
  handleGit(req: IncomingMessage, res: ServerResponse, pathname: string, search: string): Promise<void>;
  handleHook(req: IncomingMessage, res: ServerResponse): Promise<void>;
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

export function createRouter({ config, sites, runtime, handleAdmin, handleDeploy, handleReport, handleGit, handleHook, observability }: Deps) {
  const rootHost = config.origin ? new URL(config.origin).host : undefined;

  async function handleSite(req: IncomingMessage, res: ServerResponse, release: Release, pathname: string, search: string) {
    // サイトの URL はリクエストされたホストのまま渡す（KANZUME_ORIGIN はルートドメインの URL なので使わない）
    const request = toWebRequest(req, `${requestOrigin(req)}${pathname}${search}`, { "cf-connecting-ip": clientIp(req) });
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
    // git のフックからの内部の呼び出し。ホスト名でサイトを選ぶ前に受ける（IP アドレスの先頭の数字と同じ名前のサイトに横取りさせない）
    if (pathname === HOOK_PATH) return handleHook(req, res);

    const isAdmin = pathname === ADMIN_PATH || pathname.startsWith(`${ADMIN_PATH}/`);
    const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "");
    const match = matchHost(host, (name) => sites.has(name), rootHost);
    if (match.kind === "unknown") return sendText(res, 404, "Not Found");
    if (match.kind === "site") {
      // 管理画面はサイトと別のオリジン（ルートドメイン）だけで開く
      if (isAdmin) {
        const proto = requestOrigin(req).split("://")[0];
        res.writeHead(302, { location: `${config.origin ?? `${proto}://${parentHost(host)}`}${ADMIN_PATH}` });
        res.end();
        return;
      }
      const release = sites.get(match.name)?.get();
      if (!release) return sendText(res, 404, "Not Found");
      return handleSite(req, res, release, pathname, search);
    }

    if (pathname === "/_api/deploy") return handleDeploy(req, res);
    if (pathname.startsWith(`${GIT_PATH}/`)) return handleGit(req, res, pathname, search);
    if (pathname === "/_api/deploy/report") return handleReport(req, res);
    if (isAdmin) return handleAdmin(req, res, pathname);
    if (pathname.startsWith("/_api/")) return sendText(res, 404, "Not Found");

    const release = sites.root ? sites.get(sites.root)?.get() : undefined;
    if (!release) {
      if (pathname !== "/") return sendText(res, 404, "Not Found");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(EMPTY);
      return;
    }
    await handleSite(req, res, release, pathname, search);
  };
}
