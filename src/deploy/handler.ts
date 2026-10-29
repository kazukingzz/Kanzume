import type { IncomingMessage, ServerResponse } from "node:http";
import { gunzipSync } from "node:zlib";
import type { AdminState } from "../admin/state.ts";
import type { Config } from "../config.ts";
import { externalOrigin, readBody, readJson, sendJson } from "../http.ts";
import type { UploadedFile } from "../store.ts";
import { DeployLog, type Deployer } from "./deployer.ts";
import { sanitizeSource } from "./history.ts";
import { readTar, TarError } from "./tar.ts";

interface Deps {
  config: Config;
  state: AdminState;
  deployer: Deployer;
}

const EXTRACT_RATIO = 4;
const META_DIR = ".kanzume/";

function authorized(req: IncomingMessage, state: AdminState): boolean {
  const auth = req.headers.authorization ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  return !!token && state.checkDeployToken(token);
}

function parseJson(file: UploadedFile | undefined): unknown {
  if (!file) return undefined;
  try {
    return JSON.parse(file.data.toString("utf8"));
  } catch {
    return undefined;
  }
}

export function createDeployHandler({ config, state, deployer }: Deps) {
  async function handleDeploy(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") return sendJson(res, 405, { error: "POST で送ってください" }, { allow: "POST" });
    if (!authorized(req, state)) return sendJson(res, 401, { error: "Token が違います" });

    const log = new DeployLog("GitHub Actions からのデプロイを受け付けました");
    const body = await readBody(req, config.maxUploadBytes);
    if (!body) return sendJson(res, 413, { error: `アップロードは ${config.maxUploadBytes / 1024 / 1024} MB 以内にしてください` });

    let files: UploadedFile[];
    try {
      files = readTar(gunzipSync(body, { maxOutputLength: config.maxUploadBytes * EXTRACT_RATIO }));
    } catch (err) {
      const message = err instanceof TarError ? err.message : "tar.gz を展開できません（展開後のサイズが大きすぎる可能性があります）";
      return sendJson(res, 400, { error: message });
    }

    const meta = parseJson(files.find((f) => f.path === `${META_DIR}meta.json`)) as { source?: unknown } | undefined;
    const sources = parseJson(files.find((f) => f.path === `${META_DIR}sources.json`));
    const result = await deployer.deploy({
      files: files.filter((f) => !f.path.startsWith(META_DIR)),
      sources: Array.isArray(sources) ? sources : null,
      source: sanitizeSource(meta?.source),
      buildLog: files.find((f) => f.path === `${META_DIR}build.log`)?.data.toString("utf8") ?? "",
      log,
    });
    if (!result.ok) return sendJson(res, 400, { error: result.error });
    sendJson(res, 200, { name: result.release.manifest.name, release: result.release.id, url: `${externalOrigin(req, config.origin)}/` });
  }

  async function handleReport(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") return sendJson(res, 405, { error: "POST で送ってください" }, { allow: "POST" });
    if (!authorized(req, state)) return sendJson(res, 401, { error: "Token が違います" });
    const body = await readJson(req, 512 * 1024);
    const name = typeof body?.name === "string" ? body.name.slice(0, 63) : null;
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
