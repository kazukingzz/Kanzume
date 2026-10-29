import { randomBytes } from "node:crypto";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { closeSiteDb } from "../bindings/db.ts";
import type { Config } from "../config.ts";
import type { Deployer } from "../deploy/deployer.ts";
import { deployFromGitHub, type GitHubOptions } from "../deploy/github.ts";
import type { DeployHistory } from "../deploy/history.ts";
import { externalOrigin, readJson, sendJson, sendText } from "../http.ts";
import type { Observability } from "../observability/events.ts";
import type { Runtime } from "../runtime/runtime.ts";
import type { Store } from "../store.ts";
import { listFiles, readFile, type FileGroup } from "./files.ts";
import { Sessions, SESSION_COOKIE, readCookie } from "./session.ts";
import { safeEqual, type AdminState } from "./state.ts";

export const ADMIN_PATH = "/_admin/kanzume";

const WEB_DIR = new URL("../../web/admin/", import.meta.url);
const STATIC: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/admin.js": { file: "admin.js", type: "text/javascript; charset=utf-8" },
  "/admin.css": { file: "admin.css", type: "text/css; charset=utf-8" },
};
const FILE_GROUPS: FileGroup[] = ["source", "config", "worker", "assets"];

interface Deps {
  config: Config;
  state: AdminState;
  store: Store;
  runtime: Runtime;
  history: DeployHistory;
  observability: Observability;
  deployer: Deployer;
  github?: Partial<GitHubOptions>;
}

export function createAdminHandler({ config, state, store, runtime, history, observability, deployer, github }: Deps) {
  const sessions = new Sessions();
  let githubDeploying = false;

  const sessionCookie = (origin: string, value: string, maxAge: number) =>
    `${SESSION_COOKIE}=${value}; Path=${ADMIN_PATH}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${origin.startsWith("https:") ? "; Secure" : ""}`;

  const login = (res: ServerResponse, origin: string) => {
    sendJson(res, 200, { ok: true }, { "set-cookie": sessionCookie(origin, sessions.create(), 7 * 24 * 60 * 60) });
  };

  const consume = (challenge: string) => sessions.consumeChallenge(challenge);

  const allowedToRegister = (authenticated: boolean, body: Record<string, unknown> | null): string | null => {
    if (authenticated) return null;
    if (state.credentials.length === 0) {
      return safeEqual(String(body?.setupToken ?? ""), config.setupToken) ? null : "セットアップトークンが違います";
    }
    return state.checkTeamId(String(body?.teamId ?? "")) ? null : "チーム ID が違います";
  };

  return async function handleAdmin(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    const origin = externalOrigin(req, config.origin);
    const rpID = new URL(origin).hostname;
    const sub = pathname.slice(ADMIN_PATH.length) || "/";
    const query = new URL(req.url ?? "/", "http://admin").searchParams;
    const method = req.method ?? "GET";

    const asset = STATIC[sub];
    if (method === "GET" && asset) {
      res.writeHead(200, {
        "content-type": asset.type,
        "cache-control": "no-store",
        "content-security-policy": "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      });
      res.end(fs.readFileSync(new URL(asset.file, WEB_DIR)));
      return;
    }

    if (!sub.startsWith("/api/")) return sendText(res, 404, "Not Found");

    if (method !== "GET" && req.headers.origin !== origin) return sendJson(res, 403, { error: "Origin が一致しません" });

    const authenticated = sessions.valid(readCookie(req, SESSION_COOKIE));
    const route = `${method} ${sub}`;

    if (route === "GET /api/state") {
      return sendJson(res, 200, { registered: state.credentials.length > 0, authenticated });
    }

    if (route === "POST /api/register/options") {
      const body = await readJson(req);
      const denied = allowedToRegister(authenticated, body);
      if (denied) return sendJson(res, 403, { error: denied });
      const options = await generateRegistrationOptions({
        rpName: "Kanzume",
        rpID,
        userName: `Kanzume（${rpID}）`,
        userDisplayName: "Kanzume メンバー",
        userID: randomBytes(16),
        attestationType: "none",
        excludeCredentials: state.credentials.map((c) => ({ id: c.id, transports: c.transports })),
        authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
      });
      sessions.addChallenge(options.challenge);
      return sendJson(res, 200, options);
    }

    if (route === "POST /api/register/verify") {
      const body = await readJson(req, 256 * 1024);
      try {
        const result = await verifyRegistrationResponse({
          response: body?.response as never,
          expectedChallenge: consume,
          expectedOrigin: origin,
          expectedRPID: rpID,
          requireUserVerification: false,
        });
        if (!result.verified) return sendJson(res, 400, { error: "パスキーを検証できませんでした" });
        const { credential } = result.registrationInfo;
        await state.addCredential({
          id: credential.id,
          publicKey: Buffer.from(credential.publicKey).toString("base64url"),
          counter: credential.counter,
          transports: credential.transports,
          createdAt: new Date().toISOString(),
        });
        return login(res, origin);
      } catch (err) {
        return sendJson(res, 400, { error: (err as Error).message });
      }
    }

    if (route === "POST /api/login/options") {
      const body = await readJson(req);
      if (state.credentials.length === 0) return sendJson(res, 400, { error: "パスキーが未登録です" });
      if (!state.checkTeamId(String(body?.teamId ?? ""))) return sendJson(res, 403, { error: "チーム ID が違います" });
      const options = await generateAuthenticationOptions({
        rpID,
        allowCredentials: state.credentials.map((c) => ({ id: c.id, transports: c.transports })),
        userVerification: "preferred",
      });
      sessions.addChallenge(options.challenge);
      return sendJson(res, 200, options);
    }

    if (route === "POST /api/login/verify") {
      const body = await readJson(req, 256 * 1024);
      const response = body?.response as { id?: string } | undefined;
      const stored = state.credentials.find((c) => c.id === response?.id);
      if (!stored) return sendJson(res, 400, { error: "登録されていないパスキーです" });
      try {
        const result = await verifyAuthenticationResponse({
          response: response as never,
          expectedChallenge: consume,
          expectedOrigin: origin,
          expectedRPID: rpID,
          credential: {
            id: stored.id,
            publicKey: Buffer.from(stored.publicKey, "base64url"),
            counter: stored.counter,
            transports: stored.transports,
          },
          requireUserVerification: false,
        });
        if (!result.verified) return sendJson(res, 400, { error: "パスキーを検証できませんでした" });
        await state.updateCounter(stored.id, result.authenticationInfo.newCounter);
        return login(res, origin);
      } catch (err) {
        return sendJson(res, 400, { error: (err as Error).message });
      }
    }

    if (route === "POST /api/logout") {
      sessions.destroy(readCookie(req, SESSION_COOKIE));
      return sendJson(res, 200, { ok: true }, { "set-cookie": sessionCookie(origin, "", 0) });
    }

    if (!authenticated) return sendJson(res, 401, { error: "ログインしてください" });

    if (route === "GET /api/overview") {
      return sendJson(res, 200, {
        url: origin,
        token: state.deployToken,
        teamId: state.teamId,
        members: state.credentials.length,
      });
    }

    if (route === "POST /api/token/rotate") {
      return sendJson(res, 200, { token: await state.rotateDeployToken() });
    }

    const release = store.get();

    if (route === "GET /api/site") {
      const m = release?.manifest;
      return sendJson(res, 200, {
        url: `${origin}/`,
        release: release
          ? {
              id: release.id,
              name: m!.name,
              deployedAt: release.deployedAt,
              deployment: history.forRelease(release.id),
              main: m!.main,
              compatibilityDate: m!.compatibilityDate,
              compatibilityFlags: m!.compatibilityFlags,
              vars: m!.vars,
              kv: m!.kvNamespaces.map((k) => k.binding),
              r2: m!.r2Buckets.map((b) => ({ binding: b.binding, bucket: b.bucketName })),
              assets: m!.assets,
            }
          : null,
        latest: history.latest(),
      });
    }

    if (route === "DELETE /api/site") {
      runtime.evict();
      closeSiteDb(store.siteDir);
      await store.remove();
      history.clear();
      observability.clear();
      return sendJson(res, 200, { ok: true });
    }

    if (route === "POST /api/site/deploy-github") {
      const body = await readJson(req);
      const url = typeof body?.url === "string" ? body.url : "";
      if (!url) return sendJson(res, 400, { error: "GitHub の URL を入力してください" });
      if (githubDeploying) return sendJson(res, 409, { error: "別のデプロイを実行中です" });
      githubDeploying = true;
      try {
        const result = await deployFromGitHub(url, deployer, { maxBytes: config.maxUploadBytes, ...github });
        return result.ok
          ? sendJson(res, 200, { release: result.release.id, url: `${origin}/` })
          : sendJson(res, 400, { error: result.error });
      } finally {
        githubDeploying = false;
      }
    }

    if (route === "GET /api/site/deployments") return sendJson(res, 200, { deployments: history.list(), active: release?.id ?? null });

    const deployment = /^GET \/api\/site\/deployments\/([^/]+)$/.exec(route);
    if (deployment) {
      const found = history.get(decodeURIComponent(deployment[1]));
      return found ? sendJson(res, 200, found) : sendJson(res, 404, { error: "デプロイが見つかりません" });
    }

    if (route === "GET /api/site/files") {
      return sendJson(res, 200, release ? { release: release.id, groups: listFiles(release) } : { release: null, groups: null });
    }

    if (route === "GET /api/site/file") {
      const group = query.get("group") as FileGroup;
      if (!release || !FILE_GROUPS.includes(group)) return sendJson(res, 404, { error: "ファイルが見つかりません" });
      const content = readFile(release, group, query.get("path") ?? "");
      return content ? sendJson(res, 200, content) : sendJson(res, 404, { error: "ファイルが見つかりません" });
    }

    if (route === "GET /api/site/metrics") return sendJson(res, 200, observability.metrics(query.get("range") ?? "24h"));

    if (route === "GET /api/site/events") {
      const num = (k: string) => (query.get(k) ? Number(query.get(k)) : undefined);
      const result = query.get("result");
      const kind = query.get("kind");
      return sendJson(res, 200, {
        events: observability.events({
          before: num("before"),
          after: num("after"),
          from: num("from"),
          limit: num("limit"),
          result: result === "ok" || result === "error" ? result : undefined,
          kind: kind === "worker" || kind === "asset" ? kind : undefined,
          q: query.get("q")?.trim() || undefined,
        }),
      });
    }

    const event = /^GET \/api\/site\/events\/(\d+)$/.exec(route);
    if (event) {
      const found = observability.event(Number(event[1]));
      return found ? sendJson(res, 200, found) : sendJson(res, 404, { error: "イベントが見つかりません" });
    }

    return sendJson(res, 404, { error: "Not Found" });
  };
}
