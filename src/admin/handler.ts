/**
 * 管理画面（/_admin/kanzume）: 画面のファイルと JSON の API。
 * API はルート表（routes/*.ts）で、権限（auth）はここでまとめて確かめる
 */
import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UserFacingError } from "../errors.ts";
import { requestOrigin, rootOrigin, sendJson, sendText } from "../http.ts";
import { isInside } from "../paths.ts";
import { ADMIN_PATH, type AdminDeps, compile, type Ctx, match, Reply, readBodyJson, type SiteRef } from "./context.ts";
import { adminRoutes } from "./routes/admin.ts";
import { authRoutes } from "./routes/auth.ts";
import { dataRoutes } from "./routes/data.ts";
import { deployRoutes } from "./routes/deploy.ts";
import { meRoutes } from "./routes/me.ts";
import { observabilityRoutes } from "./routes/observability.ts";
import { repoRoutes } from "./routes/repos.ts";
import { siteRoutes } from "./routes/sites.ts";
import { userRoutes } from "./routes/users.ts";
import { Challenges, readCookie, SESSION_COOKIE } from "./session.ts";

export { ADMIN_PATH } from "./context.ts";

const WEB_DIR = fileURLToPath(new URL("../../web/admin/", import.meta.url));
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
};
const CSP = "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'";

const ROUTES = compile([
  ...authRoutes,
  ...meRoutes,
  ...userRoutes,
  ...adminRoutes,
  ...repoRoutes,
  ...siteRoutes,
  ...deployRoutes,
  ...dataRoutes,
  ...observabilityRoutes,
]);

/** web/admin の下のファイル（画面・スクリプト・スタイル・画像）を返す。なければ false */
async function serveStatic(res: ServerResponse, sub: string): Promise<boolean> {
  const rel = sub === "/" ? "index.html" : sub.slice(1);
  // 隠しファイルや、ディレクトリの外は返さない
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(rel) || rel.split("/").some((p) => p === "" || p.startsWith("."))) return false;
  const type = TYPES[path.extname(rel)];
  const file = path.join(WEB_DIR, rel);
  if (!type || !isInside(WEB_DIR, file)) return false;
  let data: Buffer;
  try {
    data = await fs.readFile(file);
  } catch {
    return false;
  }
  // SVG に CSP を付けないのは、SVG 内の <style>（ダークモード用の配色）が style-src で止められてしまうため
  res.writeHead(200, {
    "content-type": type,
    "cache-control": "no-store",
    ...(type === "image/svg+xml" ? {} : { "content-security-policy": CSP }),
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  res.end(data);
  return true;
}

export function createAdminHandler(deps: Omit<AdminDeps, "challenges">) {
  const full: AdminDeps = { ...deps, challenges: new Challenges() };
  const { state, sites, config } = full;

  return async function handleAdmin(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    const sub = pathname.slice(ADMIN_PATH.length) || "/";
    const method = req.method ?? "GET";
    if (!sub.startsWith("/api/")) {
      if (method === "GET" && (await serveStatic(res, sub))) return;
      return sendText(res, 404, "Not Found");
    }

    // 管理画面自身のオリジン（Origin の照合とパスキー）は、開いているホストから決める。
    // サイト以外のホストならどこでも開けるので、ルートドメインの設定とは別にする
    const origin = requestOrigin(req);
    if (method !== "GET" && req.headers.origin !== origin) return sendJson(res, 403, { error: "Origin が一致しません" });

    try {
      const found = match(ROUTES, method, sub);
      if (found === null) return sendJson(res, 404, { error: "Not Found" });
      if (found === "methodMismatch") return sendJson(res, 405, { error: "このメソッドは使えません" });
      const { route, params } = found;

      const sessionId = readCookie(req, SESSION_COOKIE);
      const user = state.sessionUser(sessionId);
      if (route.auth !== "public" && !user) return sendJson(res, 401, { error: "ログインしてください" });
      const isAdmin = user?.role === "admin";
      const canSite = (name: string) => isAdmin || (user?.sites.includes(name) ?? false);
      if ((route.auth === "admin" || route.auth === "siteAdmin") && !isAdmin) return sendJson(res, 403, { error: "この操作の権限がありません" });

      let site: SiteRef | undefined;
      if (route.auth === "site" || route.auth === "siteAdmin") {
        const name = params.site;
        if (!canSite(name)) return sendJson(res, 403, { error: "この操作の権限がありません" });
        const store = sites.get(name);
        if (!store) return sendJson(res, 404, { error: "サイトが見つかりません" });
        site = { name, store, release: store.get() };
      }

      const ctx: Ctx = {
        deps: full,
        req,
        res,
        origin,
        rpID: new URL(origin).hostname,
        siteRoot: rootOrigin(req, config.origin, state.domain),
        query: new URL(req.url ?? "/", "http://admin").searchParams,
        params,
        sessionId,
        user,
        isAdmin,
        canSite,
        get site(): SiteRef {
          if (!site) throw new Error(`${route.path} はサイトのルートではありません`);
          return site;
        },
        body: (limit) => readBodyJson(req, limit),
      };
      const result = await route.handle(ctx);
      if (res.headersSent || res.writableEnded) return;
      if (result instanceof Reply) return sendJson(res, result.status, result.body, result.headers);
      return sendJson(res, 200, result ?? { ok: true });
    } catch (err) {
      if (err instanceof UserFacingError) {
        if (!res.headersSent) return sendJson(res, err.status, { error: err.message });
        res.destroy();
        return;
      }
      throw err;
    }
  };
}
