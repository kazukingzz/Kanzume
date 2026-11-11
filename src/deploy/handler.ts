/** GitHub Actions（action/deploy.mjs）からのデプロイ（/_api/deploy）と、ビルドの失敗の報告（/_api/deploy/report） */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AdminState } from "../admin/state.ts";
import type { Config } from "../config.ts";
import { tooLarge, UserFacingError } from "../errors.ts";
import { readBody, readJson, requestToken, rootOrigin, sendJson } from "../http.ts";
import { normalizeSiteName, siteNotFound, type Sites } from "../sites.ts";
import type { UploadedFile } from "../store.ts";
import { DeployLog, type Deployer } from "./deployer.ts";
import { sanitizeSource } from "./history.ts";
import { extractTarGz } from "./tar.ts";

interface Deps {
  config: Config;
  state: AdminState;
  sites: Sites;
  deployer: Deployer;
}

/** Action が tar.gz に入れる、デプロイの情報（コミット・ソース・ビルドログ） */
const META_DIR = ".kanzume/";

function parseJson(file: UploadedFile | undefined): unknown {
  if (!file) return undefined;
  try {
    return JSON.parse(file.data.toString("utf8"));
  } catch {
    return undefined;
  }
}

export function createDeployHandler({ config, state, sites, deployer }: Deps) {
  async function handleDeploy(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") return sendJson(res, 405, { error: "POST で送ってください" }, { allow: "POST" });
    // 個人トークン。メンバーのトークンなら、デプロイできるのは参加しているサイトだけ
    const access = state.deployAccess(requestToken(req));
    if (!access) return sendJson(res, 401, { error: "Token が違います" });
    // デプロイ先は Action の site（サイトの ID）で指定する（wrangler の name は使わない）。サイトは先に管理画面で追加しておく
    const site = normalizeSiteName(req.headers["x-kanzume-site"]);
    if (!site) return sendJson(res, 400, { error: "デプロイ先のサイトを指定してください（Action の site）" });
    if (access.sites !== null && !access.sites.includes(site)) {
      return sendJson(res, 403, { error: `このトークンでは、参加しているサイト（${access.sites.join(", ") || "なし"}）にしかデプロイできません` });
    }
    if (!sites.has(site)) return sendJson(res, 404, { error: siteNotFound(site).message });

    const log = new DeployLog("GitHub Actions からのデプロイを受け付けました");
    try {
      const result = await deployer.intake(async () => {
        const body = await readBody(req, config.maxUploadBytes);
        if (!body) throw tooLarge(config.maxUploadBytes);
        const files = extractTarGz(body, config.maxUploadBytes);
        const meta = parseJson(files.find((f) => f.path === `${META_DIR}meta.json`)) as { source?: unknown } | undefined;
        const sources = parseJson(files.find((f) => f.path === `${META_DIR}sources.json`));
        return deployer.deploy({
          // 管理者のトークンのときだけ、最初のサイトをルートにする
          autoRoot: access.autoRoot,
          siteName: site,
          files: files.filter((f) => !f.path.startsWith(META_DIR)),
          sources: Array.isArray(sources) ? sources : null,
          source: sanitizeSource(meta?.source),
          buildLog: files.find((f) => f.path === `${META_DIR}build.log`)?.data.toString("utf8") ?? "",
          log,
        });
      });
      if (!result.ok) return sendJson(res, 400, { error: result.error });
      sendJson(res, 200, {
        name: site,
        release: result.release.id,
        url: sites.urls(rootOrigin(req, config.origin, state.domain), site).url,
      });
    } catch (err) {
      if (!(err instanceof UserFacingError)) throw err;
      // 本文が大きすぎる・tar.gz を読めないなど。デプロイの履歴にも残す
      deployer.recordFailure(site, err.message, { source: {}, buildLog: "", log });
      sendJson(res, err.status, { error: err.message });
    }
  }

  async function handleReport(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") return sendJson(res, 405, { error: "POST で送ってください" }, { allow: "POST" });
    const access = state.deployAccess(requestToken(req));
    if (!access) return sendJson(res, 401, { error: "Token が違います" });
    const body = await readJson(req, 512 * 1024);
    // メンバーのトークンでは、ほかのサイトの履歴に書かせない（以前の Action は name で送る）
    const requested = normalizeSiteName(body?.site ?? body?.name) || null;
    const name = access.sites === null || (requested && access.sites.includes(requested)) ? requested : null;
    const error = typeof body?.error === "string" ? body.error.slice(0, 2000) : "ビルドに失敗しました";
    const log = new DeployLog("GitHub Actions でのビルドに失敗したため、アップロードされませんでした");
    deployer.recordFailure(name, error, {
      source: sanitizeSource(body?.source),
      buildLog: typeof body?.buildLog === "string" ? body.buildLog : "",
      log,
    });
    sendJson(res, 200, { ok: true });
  }

  return { handleDeploy, handleReport };
}
