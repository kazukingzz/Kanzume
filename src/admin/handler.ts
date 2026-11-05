import { randomBytes } from "node:crypto";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { Backup } from "../backup/backup.ts";
import type { Config } from "../config.ts";
import type { Deployer } from "../deploy/deployer.ts";
import { DeployLog } from "../deploy/deployer.ts";
import { deployFromGitHub, fetchFromGitHub, GitHubError, inspectFiles, type GitHubOptions } from "../deploy/github.ts";
import { ConfigError } from "../deploy/wrangler.ts";
import type { DeployHistory } from "../deploy/history.ts";
import { configuredRootHost, readJson, requestOrigin, rootOrigin, sendJson, sendText, siteOrigin } from "../http.ts";
import type { Observability } from "../observability/events.ts";
import type { ResourceMonitor } from "../observability/resources.ts";
import type { Runtime } from "../runtime/runtime.ts";
import { SettingsError, type SettingsPatch, type Sites } from "../sites.ts";
import { PROJECT_NAME } from "../store.ts";
import { RepoError, type Repos } from "../git/repos.ts";
import { GIT_PATH } from "../git/server.ts";
import { listFiles, readFile, type FileGroup } from "./files.ts";
import { describeDevice, normalizePasskeyName, providerName } from "./passkeys.ts";
import { Challenges, SESSION_COOKIE, SESSION_COOKIE_MAX_AGE, readCookie } from "./session.ts";
import { DomainError, safeEqual, type AdminState } from "./state.ts";

export const ADMIN_PATH = "/_admin/kanzume";

const WEB_DIR = new URL("../../web/admin/", import.meta.url);
const STATIC: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/admin.js": { file: "admin.js", type: "text/javascript; charset=utf-8" },
  "/admin.css": { file: "admin.css", type: "text/css; charset=utf-8" },
  "/logo.svg": { file: "logo.svg", type: "image/svg+xml" },
};
const FILE_GROUPS: FileGroup[] = ["source", "config", "worker", "assets"];

interface Deps {
  config: Config;
  state: AdminState;
  sites: Sites;
  repos: Repos;
  runtime: Runtime;
  history: DeployHistory;
  observability: Observability;
  resources: ResourceMonitor;
  deployer: Deployer;
  backup?: Backup | null;
  github?: Partial<GitHubOptions>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** リクエストの vars / secrets を設定の変更にする。値が文字列でないものは文字列にし、シークレットの null は削除 */
function envPatch(body: Record<string, unknown> | null): SettingsPatch {
  const patch: SettingsPatch = {};
  if (isRecord(body?.vars)) patch.vars = Object.fromEntries(Object.entries(body.vars).map(([k, v]) => [k, String(v ?? "")]));
  if (isRecord(body?.secrets)) patch.secrets = Object.fromEntries(Object.entries(body.secrets).map(([k, v]) => [k, v === null ? null : String(v)]));
  return patch;
}

export function createAdminHandler({ config, state, sites, repos, runtime, history, observability, resources, deployer, backup, github }: Deps) {
  const challenges = new Challenges();
  let githubDeploying = false;

  const sessionCookie = (origin: string, value: string, maxAge: number) =>
    `${SESSION_COOKIE}=${value}; Path=${ADMIN_PATH}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${origin.startsWith("https:") ? "; Secure" : ""}`;

  const login = async (res: ServerResponse, origin: string) => {
    sendJson(res, 200, { ok: true }, { "set-cookie": sessionCookie(origin, await state.createSession(), SESSION_COOKIE_MAX_AGE) });
  };

  const allowedToRegister = (authenticated: boolean, body: Record<string, unknown> | null): string | null => {
    if (authenticated) return null;
    if (state.credentials.length === 0) {
      return safeEqual(String(body?.setupToken ?? ""), config.setupToken) ? null : "セットアップトークンが違います";
    }
    return state.checkTeamId(String(body?.teamId ?? "")) ? null : "チーム ID が違います";
  };

  return async function handleAdmin(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    // 管理画面自身のオリジン（Origin の照合とパスキー）は、開いているホストから決める。
    // サイト以外のホストならどこでも開けるので、ルートドメインの設定とは別にする
    const origin = requestOrigin(req);
    const rpID = new URL(origin).hostname;
    // サイトの URL を作る基準
    const siteRoot = rootOrigin(req, config.origin, state.domain);
    const sub = pathname.slice(ADMIN_PATH.length) || "/";
    const query = new URL(req.url ?? "/", "http://admin").searchParams;
    const method = req.method ?? "GET";

    const asset = STATIC[sub];
    if (method === "GET" && asset) {
      // ロゴに CSP を付けないのは、SVG 内の <style>（ダークモード用の配色）が style-src で止められてしまうため
      const csp = asset.type === "image/svg+xml" ? {} : { "content-security-policy": "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'" };
      res.writeHead(200, {
        "content-type": asset.type,
        "cache-control": "no-store",
        ...csp,
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      });
      res.end(fs.readFileSync(new URL(asset.file, WEB_DIR)));
      return;
    }

    if (!sub.startsWith("/api/")) return sendText(res, 404, "Not Found");

    if (method !== "GET" && req.headers.origin !== origin) return sendJson(res, 403, { error: "Origin が一致しません" });

    const sessionId = readCookie(req, SESSION_COOKIE);
    const authenticated = state.hasSession(sessionId);
    const route = `${method} ${sub}`;

    if (route === "GET /api/state") {
      const renew: Record<string, string> = authenticated ? { "set-cookie": sessionCookie(origin, sessionId!, SESSION_COOKIE_MAX_AGE) } : {};
      return sendJson(res, 200, { registered: state.credentials.length > 0, authenticated, domainFromEnv: !!config.origin }, renew);
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
        challenge: challenges.create("register"),
        attestationType: "none",
        excludeCredentials: state.credentials.map((c) => ({ id: c.id, transports: c.transports })),
        authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
      });
      return sendJson(res, 200, options);
    }

    if (route === "POST /api/register/verify") {
      const body = await readJson(req, 256 * 1024);
      let challenge = "";
      let result;
      try {
        result = await verifyRegistrationResponse({
          response: body?.response as never,
          expectedChallenge: (c: string) => ((challenge = c), challenges.check(c, "register")),
          expectedOrigin: origin,
          expectedRPID: rpID,
          requireUserVerification: false,
        });
      } catch (err) {
        return sendJson(res, 400, { error: (err as Error).message });
      }
      if (!result.verified) return sendJson(res, 400, { error: "パスキーを検証できませんでした" });
      challenges.markUsed(challenge);
      const { credential, aaguid } = result.registrationInfo;
      const device = describeDevice(req.headers["user-agent"]);
      await state.addCredential({
        id: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString("base64url"),
        counter: credential.counter,
        transports: credential.transports,
        createdAt: new Date().toISOString(),
        name: providerName(aaguid) ?? device ?? "",
        aaguid,
        device,
      });
      return login(res, origin);
    }

    if (route === "POST /api/login/options") {
      if (state.credentials.length === 0) return sendJson(res, 400, { error: "パスキーが未登録です" });
      const options = await generateAuthenticationOptions({
        rpID,
        challenge: challenges.create("login"),
        allowCredentials: state.credentials.map((c) => ({ id: c.id, transports: c.transports })),
        userVerification: "preferred",
      });
      return sendJson(res, 200, options);
    }

    if (route === "POST /api/login/verify") {
      const body = await readJson(req, 256 * 1024);
      const response = body?.response as { id?: string } | undefined;
      const stored = state.credentials.find((c) => c.id === response?.id);
      if (!stored) return sendJson(res, 400, { error: "登録されていないパスキーです" });
      let challenge = "";
      let result;
      try {
        result = await verifyAuthenticationResponse({
          response: response as never,
          expectedChallenge: (c: string) => ((challenge = c), challenges.check(c, "login")),
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
      } catch (err) {
        return sendJson(res, 400, { error: (err as Error).message });
      }
      if (!result.verified) return sendJson(res, 400, { error: "パスキーを検証できませんでした" });
      challenges.markUsed(challenge);
      await state.updateCounter(stored.id, result.authenticationInfo.newCounter);
      return login(res, origin);
    }

    if (route === "POST /api/logout") {
      try {
        await state.removeSession(sessionId);
      } catch (err) {
        console.error("[kanzume] ログアウトの保存に失敗:", err);
        return sendJson(res, 500, { error: "ログアウトできませんでした。もう一度試してください" });
      }
      return sendJson(res, 200, { ok: true }, { "set-cookie": sessionCookie(origin, "", 0) });
    }

    if (!authenticated) return sendJson(res, 401, { error: "ログインしてください" });

    if (route === "GET /api/overview") {
      return sendJson(res, 200, {
        url: origin,
        token: state.deployToken,
        teamId: state.teamId,
        members: state.credentials.length,
        domain: {
          value: state.domain,
          fromEnv: Boolean(config.origin),
          effective: configuredRootHost(config.origin, state.domain) ?? new URL(origin).host,
          current: new URL(origin).host,
        },
      });
    }

    if (route === "POST /api/domain") {
      if (config.origin) return sendJson(res, 409, { error: "環境変数 KANZUME_ORIGIN が優先されています。変えるには環境変数を変更してください" });
      const body = await readJson(req);
      try {
        return sendJson(res, 200, { domain: await state.setDomain(String(body?.domain ?? "")) });
      } catch (err) {
        if (err instanceof DomainError) return sendJson(res, 400, { error: err.message });
        throw err;
      }
    }

    if (route === "GET /api/backup") return sendJson(res, 200, backup ? backup.status() : { enabled: false });

    if (route === "POST /api/backup/run") {
      if (!backup) return sendJson(res, 400, { error: "KANZUME_BACKUP_URL が設定されていません" });
      const run = await backup.backupNow("手動");
      return sendJson(res, run.ok ? 200 : 502, { ...backup.status(), error: run.error });
    }

    if (route === "GET /api/passkeys") {
      return sendJson(res, 200, {
        passkeys: state.credentials.map((c) => ({
          id: c.id,
          name: c.name ?? "",
          provider: providerName(c.aaguid) ?? null,
          device: c.device ?? null,
          createdAt: c.createdAt,
          lastUsedAt: c.lastUsedAt ?? null,
        })),
      });
    }

    if (route === "POST /api/passkeys/rename") {
      const body = await readJson(req);
      const name = normalizePasskeyName(body?.name);
      if (!name) return sendJson(res, 400, { error: "名前を入力してください" });
      const ok = await state.renameCredential(String(body?.id ?? ""), name);
      return ok ? sendJson(res, 200, { name }) : sendJson(res, 404, { error: "パスキーが見つかりません" });
    }

    // ---------- Git リポジトリ ----------

    // push 先のサイトはリポジトリと同じ名前（name が違う push はデプロイしない）なので、そのサイトがあるかだけを見る
    const repoInfo = async (name: string) => ({
      ...(await repos.summary(name)),
      cloneUrl: `${origin}${GIT_PATH}/${name}.git`,
      site: sites.get(name)?.get() ? name : null,
    });

    if (route === "GET /api/repos") {
      // 1 つ読めないリポジトリがあっても、一覧全体は返す
      const list = await Promise.all(
        (await repos.names()).map((name) =>
          repoInfo(name).catch((err) => {
            console.error(`[git] リポジトリ ${name} を読めません:`, err);
            return { name, broken: true, cloneUrl: `${origin}${GIT_PATH}/${name}.git`, site: null, defaultBranch: "main", lastPush: null, size: 0 };
          }),
        ),
      );
      return sendJson(res, 200, { repos: list });
    }

    if (route === "POST /api/repos") {
      const body = await readJson(req);
      const name = String(body?.name ?? "").trim();
      // 同じ名前のサイトがあると、このリポジトリへの push でそのサイトを上書きすることになるので、確認を求める
      if (sites.get(name)?.get() && body?.confirm !== true) {
        return sendJson(res, 409, {
          error: `同じ名前のサイト（${name}）があります。このリポジトリに push すると、そのサイトを上書きします`,
          needsConfirm: true,
        });
      }
      try {
        await repos.create(name);
      } catch (err) {
        if (err instanceof RepoError) return sendJson(res, 400, { error: err.message });
        throw err;
      }
      return sendJson(res, 200, await repoInfo(name));
    }

    const repoRoute = /^(GET|POST|DELETE) \/api\/repos\/([a-z0-9-]+)(\/.*)?$/.exec(route);
    if (repoRoute) {
      const [, , name, rest = ""] = repoRoute;
      if (!(await repos.exists(name))) return sendJson(res, 404, { error: "リポジトリが見つかりません" });
      const key = `${method} ${rest}`;
      const ref = query.get("ref") || (await repos.defaultBranch(name));
      const tokenInfo = (t: { id: string; scope: string; createdAt: string; expiresAt: string | null }) => ({ id: t.id, scope: t.scope, createdAt: t.createdAt, expiresAt: t.expiresAt });
      try {
        if (key === "GET ") {
          return sendJson(res, 200, { ...(await repoInfo(name)), refs: await repos.refs(name), tokens: state.repoTokens(name).map(tokenInfo) });
        }
        if (key === "DELETE ") {
          await repos.remove(name);
          await state.revokeRepoTokens(name);
          return sendJson(res, 200, { ok: true });
        }
        if (key === "GET /log") return sendJson(res, 200, { ref, commits: await repos.log(name, ref) });
        if (key === "GET /tree") return sendJson(res, 200, { ref, files: await repos.tree(name, ref) });
        if (key === "GET /blob") {
          const blob = await repos.blob(name, ref, query.get("path") ?? "");
          return blob ? sendJson(res, 200, blob) : sendJson(res, 404, { error: "ファイルが見つかりません" });
        }
        if (key === "POST /tokens") {
          const body = await readJson(req);
          const scope = body?.scope === "read" ? "read" : body?.scope === "write" ? "write" : null;
          const ttl = body?.ttl === null ? null : Number(body?.ttl);
          if (!scope) return sendJson(res, 400, { error: "権限は read か write を選んでください" });
          if (ttl !== null && !(ttl > 0 && ttl <= 365 * 86400)) return sendJson(res, 400, { error: "期限が不正です" });
          const { token, info } = await state.createRepoToken(name, scope, ttl);
          return sendJson(res, 200, { token, ...tokenInfo(info) });
        }
        const revoke = /^DELETE \/tokens\/([0-9a-f]+)$/.exec(key);
        if (revoke) {
          return (await state.revokeRepoTokens(name, revoke[1])) ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: "トークンが見つかりません" });
        }
      } catch (err) {
        if (err instanceof RepoError) return sendJson(res, 400, { error: err.message });
        throw err;
      }
      return sendJson(res, 404, { error: "Not Found" });
    }

    if (route === "GET /api/samples") {
      const sample = (dir: string) => `${config.samplesRepo}/examples/${dir}`;
      return sendJson(res, 200, { worker: sample("worker"), portfolio: sample("portfolio") });
    }

    if (route === "GET /api/resources") return sendJson(res, 200, resources.snapshot());

    if (route === "POST /api/token/rotate") {
      return sendJson(res, 200, { token: await state.rotateDeployToken() });
    }

    const siteUrls = (name: string) => sites.urls(siteRoot, name);

    /** デプロイ前の設定画面で使う: その名前のサイトがあるか、サブドメインがほかのサイトに使われていないか、今の設定 */
    const siteInfo = (name: string) => {
      const valid = PROJECT_NAME.test(name);
      const exists = valid && !!sites.get(name)?.get();
      const owner = valid ? sites.resolve(name) : undefined;
      const settings = exists ? sites.settings(name) : null;
      return {
        valid,
        exists,
        takenBy: owner && owner !== name ? owner : null,
        url: valid ? `${siteOrigin(siteRoot, exists ? sites.subdomain(name) : name)}/` : null,
        current: settings ? { vars: settings.vars, secretKeys: Object.keys(settings.secrets).sort() } : null,
      };
    };

    if (route === "GET /api/sites") {
      const listed = sites.list();
      const names = new Set(listed.map((x) => x.name));
      return sendJson(res, 200, {
        root: sites.root,
        sites: listed.map(({ name, store }) => {
          const release = store.get()!;
          return { name, ...siteUrls(name), deployedAt: release.deployedAt, latest: history.latest(name) };
        }),
        // 初回のデプロイに失敗して、まだ一覧に出ないサイトのデプロイ
        pending: history
          .list()
          .filter((d) => !names.has(d.name))
          .slice(0, 10),
      });
    }

    if (route === "POST /api/root-site") {
      const body = await readJson(req);
      const name = body?.name === null ? null : String(body?.name ?? "");
      if (name !== null && !sites.get(name)?.get()) return sendJson(res, 404, { error: "サイトが見つかりません" });
      await sites.setRoot(name);
      return sendJson(res, 200, { root: sites.root });
    }

    const pendingDeployment = /^GET \/api\/deployments\/([^/]+)$/.exec(route);
    if (pendingDeployment) {
      const found = history.get(decodeURIComponent(pendingDeployment[1]));
      return found ? sendJson(res, 200, found) : sendJson(res, 404, { error: "デプロイが見つかりません" });
    }

    if (route === "POST /api/deploy-github/inspect") {
      const body = await readJson(req);
      const url = typeof body?.url === "string" ? body.url.trim() : "";
      if (!url) return sendJson(res, 400, { error: "GitHub の URL を入力してください" });
      try {
        const fetched = await fetchFromGitHub(url, { maxBytes: config.maxUploadBytes, ...github }, new DeployLog("inspect"));
        const { name, vars } = inspectFiles(fetched);
        return sendJson(res, 200, { name, vars, ...siteInfo(name) });
      } catch (err) {
        if (err instanceof GitHubError || err instanceof ConfigError) return sendJson(res, 400, { error: err.message });
        throw err;
      }
    }

    if (route === "GET /api/site-name") {
      const name = query.get("name") ?? "";
      return sendJson(res, 200, siteInfo(name));
    }

    if (route === "POST /api/deploy-github") {
      const body = await readJson(req);
      const url = typeof body?.url === "string" ? body.url : "";
      if (!url) return sendJson(res, 400, { error: "GitHub の URL を入力してください" });
      // name を省くと、今までどおり wrangler の name でデプロイする
      const siteName = typeof body?.name === "string" && body.name ? body.name.trim().toLowerCase() : undefined;
      const patch = siteName ? envPatch(body) : null;
      if (siteName) {
        if (!PROJECT_NAME.test(siteName)) return sendJson(res, 400, { error: "サイト名は英小文字・数字・ハイフンで 63 文字以内にしてください" });
        const info = siteInfo(siteName);
        if (info.takenBy) return sendJson(res, 400, { error: `サブドメイン ${siteName} はサイト ${info.takenBy} が使っています。別の名前にしてください` });
        if (info.exists && body?.confirm !== true) return sendJson(res, 409, { error: `サイト ${siteName} は既にあります。上書きしてデプロイしますか？`, exists: true });
      }
      if (githubDeploying) return sendJson(res, 409, { error: "別のデプロイを実行中です" });
      githubDeploying = true;
      let created = false;
      try {
        if (siteName && patch) {
          // 最初に読み込む Worker から新しい環境変数を使うように、デプロイの前に設定を書く
          created = !sites.has(siteName);
          await sites.ensure(siteName);
          await sites.updateSettings(siteName, patch);
          runtime.evict(sites.get(siteName)!.siteDir);
        }
        const result = await deployFromGitHub(url, deployer, { maxBytes: config.maxUploadBytes, ...github, siteName });
        if (!result.ok) {
          // 新しく作ったサイトが失敗したら、設定だけが残らないように消す
          if (created && !sites.get(siteName!)?.get()) await sites.remove(siteName!);
          return sendJson(res, 400, { error: result.error });
        }
        const name = result.release.manifest.name;
        return sendJson(res, 200, { site: name, release: result.release.id, url: siteUrls(name).url });
      } catch (err) {
        if (created && !sites.get(siteName!)?.get()) await sites.remove(siteName!);
        if (err instanceof SettingsError) return sendJson(res, 400, { error: err.message });
        throw err;
      } finally {
        githubDeploying = false;
      }
    }

    const siteRoute = /^(GET|PUT|DELETE) \/api\/sites\/([a-z0-9-]+)(\/.*)?$/.exec(route);
    if (!siteRoute) return sendJson(res, 404, { error: "Not Found" });
    const [, , name, rest = ""] = siteRoute;
    const store = sites.get(name);
    const release = store?.get();
    if (!store || !release) return sendJson(res, 404, { error: "サイトが見つかりません" });
    const siteRouteKey = `${method} ${rest}`;

    if (siteRouteKey === "GET ") {
      const m = release.manifest;
      return sendJson(res, 200, {
        name,
        ...siteUrls(name),
        root: sites.root === name,
        release: {
          id: release.id,
          name: m.name,
          deployedAt: release.deployedAt,
          deployment: history.forRelease(release.id),
          main: m.main,
          compatibilityDate: m.compatibilityDate,
          compatibilityFlags: m.compatibilityFlags,
          vars: m.vars,
          kv: m.kvNamespaces.map((k) => k.binding),
          r2: m.r2Buckets.map((b) => ({ binding: b.binding, bucket: b.bucketName })),
          assets: m.assets,
        },
        latest: history.latest(name),
      });
    }

    if (siteRouteKey === "GET /settings") {
      const settings = sites.settings(name);
      return sendJson(res, 200, {
        subdomain: sites.subdomain(name),
        vars: settings.vars,
        secretKeys: Object.keys(settings.secrets).sort(),
        wranglerVars: release.manifest.vars,
        ...siteUrls(name),
      });
    }

    if (siteRouteKey === "PUT /settings") {
      const body = await readJson(req);
      const patch: SettingsPatch = envPatch(body);
      if (body && "subdomain" in body) patch.subdomain = body.subdomain === null ? null : String(body.subdomain ?? "");
      try {
        await sites.updateSettings(name, patch);
      } catch (err) {
        if (err instanceof SettingsError) return sendJson(res, 400, { error: err.message });
        throw err;
      }
      // 次のリクエストから新しい値で Worker を読み込み直す
      runtime.evict(store.siteDir);
      return sendJson(res, 200, { ok: true, subdomain: sites.subdomain(name), ...siteUrls(name) });
    }

    if (siteRouteKey === "DELETE ") {
      runtime.evict(store.siteDir);
      await sites.remove(name);
      history.clear(name);
      observability.clear(name);
      return sendJson(res, 200, { ok: true });
    }

    if (siteRouteKey === "GET /deployments") return sendJson(res, 200, { deployments: history.list(name), active: release.id });

    const deployment = /^GET \/deployments\/([^/]+)$/.exec(siteRouteKey);
    if (deployment) {
      const found = history.get(decodeURIComponent(deployment[1]), name);
      return found ? sendJson(res, 200, found) : sendJson(res, 404, { error: "デプロイが見つかりません" });
    }

    if (siteRouteKey === "GET /files") return sendJson(res, 200, { release: release.id, groups: listFiles(release) });

    if (siteRouteKey === "GET /file") {
      const group = query.get("group") as FileGroup;
      if (!FILE_GROUPS.includes(group)) return sendJson(res, 404, { error: "ファイルが見つかりません" });
      const content = readFile(release, group, query.get("path") ?? "");
      return content ? sendJson(res, 200, content) : sendJson(res, 404, { error: "ファイルが見つかりません" });
    }

    if (siteRouteKey === "GET /metrics") return sendJson(res, 200, observability.metrics(name, query.get("range") ?? "24h"));

    if (siteRouteKey === "GET /events") {
      const num = (k: string) => (query.get(k) ? Number(query.get(k)) : undefined);
      const result = query.get("result");
      const kind = query.get("kind");
      return sendJson(res, 200, {
        events: observability.events(name, {
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

    const event = /^GET \/events\/(\d+)$/.exec(siteRouteKey);
    if (event) {
      const found = observability.event(name, Number(event[1]));
      return found ? sendJson(res, 200, found) : sendJson(res, 404, { error: "イベントが見つかりません" });
    }

    return sendJson(res, 404, { error: "Not Found" });
  };
}
