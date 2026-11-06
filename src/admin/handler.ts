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
import { BINDING_NAME, ConfigError } from "../deploy/wrangler.ts";
import { R2_BUCKET_NAME } from "../bindings/r2.ts";
import type { DeployHistory } from "../deploy/history.ts";
import { configuredRootHost, readBody, readJson, requestOrigin, rootOrigin, sendJson, sendText, siteOrigin } from "../http.ts";
import type { Observability } from "../observability/events.ts";
import type { ResourceMonitor } from "../observability/resources.ts";
import type { Runtime } from "../runtime/runtime.ts";
import { SettingsError, type SettingsPatch, type Sites } from "../sites.ts";
import { PROJECT_NAME } from "../store.ts";
import { RepoError, type Repos } from "../git/repos.ts";
import { GIT_PATH } from "../git/server.ts";
import { asText, kvDelete, kvKeys, kvNamespaces, kvPut, kvValue, PREVIEW_BYTES, r2Bucket, r2Buckets, r2List } from "./data.ts";
import { listFiles, readFile, type FileGroup } from "./files.ts";
import { describeDevice, normalizePasskeyName, providerName } from "./passkeys.ts";
import { Challenges, SESSION_COOKIE, SESSION_COOKIE_MAX_AGE, readCookie } from "./session.ts";
import { DomainError, INVITE_TTL_MS, normalizeUserName, safeEqual, UserError, type AdminState, type User } from "./state.ts";

export const ADMIN_PATH = "/_admin/kanzume";

const WEB_DIR = new URL("../../web/admin/", import.meta.url);
const STATIC: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/admin.js": { file: "admin.js", type: "text/javascript; charset=utf-8" },
  "/admin.css": { file: "admin.css", type: "text/css; charset=utf-8" },
  "/logo.svg": { file: "logo.svg", type: "image/svg+xml" },
};
const FILE_GROUPS: FileGroup[] = ["source", "config", "worker", "assets"];
/** 管理者だけが呼べる API（全体の設定） */
/** サイト名にできない名前（管理画面の URL の #/invite・#/repos と重なるもの） */
const RESERVED_SITE_NAMES = ["invite", "repos"];
const ADMIN_ROUTES = new Set([
  "POST /api/domain",
  "GET /api/backup",
  "POST /api/backup/run",
  "POST /api/token/rotate",
  "GET /api/resources",
  "POST /api/root-site",
  "GET /api/users",
]);

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

  const login = async (res: ServerResponse, origin: string, userId: string) => {
    sendJson(res, 200, { ok: true }, { "set-cookie": sessionCookie(origin, await state.createSession(userId), SESSION_COOKIE_MAX_AGE) });
  };

  /**
   * パスキーを登録できるか。誰のパスキーになるかも決める
   * - ログイン中: 自分のパスキーを足す
   * - 初回（パスキーが 1 つもない）: セットアップトークンで最初の管理者
   * - 招待トークン: そのサイトのメンバー（新しいユーザー）
   * 管理者は初回セットアップした人だけ（メンバーを管理者設定で管理者にすることはできる）
   */
  type Registration = { kind: "self"; userId: string } | { kind: "setup" } | { kind: "invite"; token: string };
  const allowedToRegister = (user: User | null, body: Record<string, unknown> | null): Registration | string => {
    if (user) return { kind: "self", userId: user.id };
    if (state.credentials.length === 0) {
      return safeEqual(String(body?.setupToken ?? ""), config.setupToken) ? { kind: "setup" } : "セットアップトークンが違います";
    }
    if (typeof body?.inviteToken === "string" && body.inviteToken) {
      return state.checkInvite(body.inviteToken) ? { kind: "invite", token: body.inviteToken } : "招待リンクが無効です（使用済み・期限切れ・取り消し済みのいずれか）";
    }
    return "パスキーを登録するには、管理者から届いた招待リンクを開いてください";
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
    const user = state.sessionUser(sessionId);
    const authenticated = user !== null;
    const route = `${method} ${sub}`;

    if (route === "GET /api/state") {
      const renew: Record<string, string> = authenticated ? { "set-cookie": sessionCookie(origin, sessionId!, SESSION_COOKIE_MAX_AGE) } : {};
      return sendJson(res, 200, { registered: state.credentials.length > 0, authenticated, domainFromEnv: !!config.origin }, renew);
    }

    if (route === "POST /api/register/options") {
      const body = await readJson(req);
      const allowed = allowedToRegister(user, body);
      if (typeof allowed === "string") return sendJson(res, 403, { error: allowed });
      const options = await generateRegistrationOptions({
        rpName: "Kanzume",
        rpID,
        userName: `Kanzume（${rpID}）`,
        userDisplayName: user?.name ?? (normalizeUserName(body?.name) || "Kanzume メンバー"),
        userID: randomBytes(16),
        challenge: challenges.create("register"),
        attestationType: "none",
        // 同じ認証器で別のユーザーとして登録するのは止めない（自分のパスキーの重複だけ防ぐ）
        excludeCredentials: (user ? state.credentialsOf(user.id) : []).map((c) => ({ id: c.id, transports: c.transports })),
        authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
      });
      return sendJson(res, 200, options);
    }

    if (route === "POST /api/register/verify") {
      const body = await readJson(req, 256 * 1024);
      // オプションを取ったあとに招待が使われたなどを防ぐため、もう一度確かめる
      const allowed = allowedToRegister(user, body);
      if (typeof allowed === "string") return sendJson(res, 403, { error: allowed });
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
      let owner: string;
      if (allowed.kind === "self") owner = allowed.userId;
      else if (allowed.kind === "setup") owner = state.setupUserId;
      else {
        const member = await state.redeemInviteAsNewUser(allowed.token, String(body?.name ?? ""));
        if (!member) return sendJson(res, 403, { error: "招待リンクが無効です（使用済み・期限切れ・取り消し済みのいずれか）" });
        owner = member.id;
      }
      await state.addCredential({
        userId: owner,
        id: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString("base64url"),
        counter: credential.counter,
        transports: credential.transports,
        createdAt: new Date().toISOString(),
        name: providerName(aaguid) ?? device ?? "",
        aaguid,
        device,
      });
      // ログイン中に足したパスキーは、セッションをそのまま使う
      if (allowed.kind === "self") return sendJson(res, 200, { ok: true });
      return login(res, origin, owner);
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
      if (!state.user(stored.userId)) return sendJson(res, 400, { error: "このパスキーのユーザーは削除されています" });
      return login(res, origin, stored.userId!);
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

    // 招待リンクを開いた人に、どのサイトへの招待かを見せる（ログイン前でも）
    if (route === "GET /api/invite") {
      const invite = state.checkInvite(query.get("token") ?? "");
      return sendJson(res, 200, invite ? { valid: true, site: invite.site, expiresAt: invite.expiresAt } : { valid: false });
    }

    if (!user) return sendJson(res, 401, { error: "ログインしてください" });

    const isAdmin = user.role === "admin";
    /** 管理者はすべてのサイト、メンバーは参加しているサイトだけ */
    const canSite = (name: string) => isAdmin || user.sites.includes(name);
    const forbidden = () => sendJson(res, 403, { error: "この操作の権限がありません" });
    const adminOnly =
      ADMIN_ROUTES.has(route) || /^(PUT|DELETE) \/api\/users\//.test(route) || /^(GET|POST|DELETE) \/api\/sites\/[a-z0-9-]+\/(members|invites)(\/|$)/.test(route);
    if (adminOnly && !isAdmin) return forbidden();

    if (route === "GET /api/overview") {
      return sendJson(res, 200, {
        url: origin,
        me: { id: user.id, name: user.name, role: user.role, sites: user.sites },
        members: state.users.length,
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

    // ---------- 個人の設定 ----------

    if (route === "GET /api/passkeys") {
      return sendJson(res, 200, {
        passkeys: state.credentialsOf(user.id).map((c) => ({
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
      const id = String(body?.id ?? "");
      if (!state.credentialsOf(user.id).some((c) => c.id === id)) return sendJson(res, 404, { error: "パスキーが見つかりません" });
      const ok = await state.renameCredential(id, name);
      return ok ? sendJson(res, 200, { name }) : sendJson(res, 404, { error: "パスキーが見つかりません" });
    }

    const passkeyDelete = /^DELETE \/api\/passkeys\/([^/]+)$/.exec(route);
    if (passkeyDelete) {
      try {
        await state.removeCredential(decodeURIComponent(passkeyDelete[1]), user.id);
      } catch (err) {
        if (err instanceof UserError) return sendJson(res, 400, { error: err.message });
        throw err;
      }
      return sendJson(res, 200, { ok: true });
    }

    if (route === "PUT /api/me") {
      const body = await readJson(req);
      try {
        const updated = await state.updateUser(user.id, { name: String(body?.name ?? "") });
        return sendJson(res, 200, { name: updated.name });
      } catch (err) {
        if (err instanceof UserError) return sendJson(res, 400, { error: err.message });
        throw err;
      }
    }

    // 個人トークン（git push と GitHub Actions に使う。扱えるサイトは自分と同じ）
    if (route === "GET /api/tokens") {
      return sendJson(res, 200, { tokens: state.userTokens(user.id).map((t) => ({ id: t.id, name: t.name, createdAt: t.createdAt, expiresAt: t.expiresAt })) });
    }

    if (route === "POST /api/tokens") {
      const body = await readJson(req);
      const ttl = body?.ttl === null || body?.ttl === undefined ? null : Number(body.ttl);
      if (ttl !== null && !(ttl > 0 && ttl <= 365 * 86400)) return sendJson(res, 400, { error: "期限が不正です" });
      const { token, info } = await state.createUserToken(user.id, String(body?.name ?? ""), ttl);
      return sendJson(res, 200, { token, id: info.id, name: info.name, createdAt: info.createdAt, expiresAt: info.expiresAt });
    }

    const tokenRevoke = /^DELETE \/api\/tokens\/([0-9a-f]+)$/.exec(route);
    if (tokenRevoke) {
      return (await state.revokeUserToken(user.id, tokenRevoke[1])) ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: "トークンが見つかりません" });
    }

    // ログイン中に招待リンクを開いたとき: 自分をそのサイトのメンバーにする
    if (route === "POST /api/invite/accept") {
      const body = await readJson(req);
      const invite = await state.consumeInvite(String(body?.token ?? ""), user.id);
      if (!invite) return sendJson(res, 400, { error: "招待リンクが無効です（使用済み・期限切れ・取り消し済みのいずれか）" });
      return sendJson(res, 200, { site: invite.site });
    }

    // ---------- メンバーの管理（管理者） ----------

    if (route === "GET /api/users") {
      return sendJson(res, 200, {
        users: state.users.map((u) => {
          const creds = state.credentialsOf(u.id);
          const used = creds.map((c) => c.lastUsedAt ?? c.createdAt).sort().at(-1) ?? null;
          return { id: u.id, name: u.name, role: u.role, sites: u.sites, createdAt: u.createdAt, passkeys: creds.length, lastUsedAt: used, me: u.id === user.id };
        }),
      });
    }

    const userRoute = /^(PUT|DELETE) \/api\/users\/([^/]+)$/.exec(route);
    if (userRoute) {
      const id = decodeURIComponent(userRoute[2]);
      try {
        if (userRoute[1] === "DELETE") {
          if (id === user.id) return sendJson(res, 400, { error: "自分は削除できません" });
          await state.removeUser(id);
          return sendJson(res, 200, { ok: true });
        }
        const body = await readJson(req);
        const role = body?.role === "admin" || body?.role === "member" ? body.role : undefined;
        const updated = await state.updateUser(id, {
          role,
          name: typeof body?.name === "string" ? body.name : undefined,
          removeSite: typeof body?.removeSite === "string" ? body.removeSite : undefined,
          addSite: typeof body?.addSite === "string" && sites.get(body.addSite)?.get() ? body.addSite : undefined,
        });
        return sendJson(res, 200, { user: updated });
      } catch (err) {
        if (err instanceof UserError) return sendJson(res, 400, { error: err.message });
        throw err;
      }
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
        (await repos.names()).filter(canSite).map((name) =>
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
      // メンバーは、自分のサイトと同じ名前のリポジトリだけ作れる
      if (!canSite(name)) return forbidden();
      // リポジトリはサイトに属する（push するとそのサイトにデプロイする）ので、先にサイトが必要
      if (!sites.has(name)) return sendJson(res, 400, { error: `サイト ${name} がありません。先にサイトを作ってください` });
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
      if (!canSite(name)) return forbidden();
      if (!(await repos.exists(name))) return sendJson(res, 404, { error: "リポジトリが見つかりません" });
      const key = `${method} ${rest}`;
      const ref = query.get("ref") || (await repos.defaultBranch(name));
      try {
        if (key === "GET ") {
          return sendJson(res, 200, { ...(await repoInfo(name)), refs: await repos.refs(name) });
        }
        if (key === "DELETE ") {
          await repos.remove(name);
          return sendJson(res, 200, { ok: true });
        }
        if (key === "GET /log") return sendJson(res, 200, { ref, commits: await repos.log(name, ref) });
        if (key === "GET /tree") return sendJson(res, 200, { ref, files: await repos.tree(name, ref) });
        if (key === "GET /blob") {
          const blob = await repos.blob(name, ref, query.get("path") ?? "");
          return blob ? sendJson(res, 200, blob) : sendJson(res, 404, { error: "ファイルが見つかりません" });
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

    /**
     * サイトの名前・サブドメインに使えないラベル。管理画面を開いているホスト（fa.example.com の fa）を
     * サイトに取られると、そのホストの管理画面・/_api・/_git がサイトのものになってしまうため
     */
    const reservedLabels = (() => {
      const labels = new Set(RESERVED_SITE_NAMES);
      const adminHost = new URL(origin).hostname;
      const rootHost = new URL(siteRoot).hostname;
      if (adminHost !== rootHost && adminHost.endsWith(`.${rootHost}`)) labels.add(adminHost.slice(0, -rootHost.length - 1));
      return labels;
    })();

    /** デプロイ前の設定画面で使う: その名前のサイトがあるか、サブドメインがほかのサイトに使われていないか、今の設定 */
    const siteInfo = (name: string) => {
      const valid = PROJECT_NAME.test(name);
      // exists はデプロイ済み（上書きの確認が要る）、created は作成済み（未デプロイを含む）
      const exists = valid && sites.deployed(name);
      const created = valid && sites.has(name);
      const owner = valid ? sites.resolve(name) : undefined;
      return {
        valid,
        exists,
        created,
        // 作成済みのサイトは自分の ID でデプロイできる（ほかのサイトがその名前をサブドメインにしていても構わない）
        takenBy: !created && owner && owner !== name ? owner : null,
        url: valid ? `${siteOrigin(siteRoot, created ? sites.subdomain(name) : name)}/` : null,
      };
    };

    if (route === "GET /api/sites") {
      const all = sites.list();
      const names = new Set(all.map((x) => x.name));
      const listed = all.filter((x) => canSite(x.name));
      return sendJson(res, 200, {
        root: sites.root,
        sites: listed.map(({ name, store }) => {
          const release = store.get();
          return { name, ...siteUrls(name), deployed: !!release, deployedAt: release?.deployedAt ?? null, latest: history.latest(name) ?? null };
        }),
        // 初回のデプロイに失敗して、まだ一覧に出ないサイトのデプロイ
        pending: isAdmin
          ? history
              .list()
              .filter((d) => !names.has(d.name))
              .slice(0, 10)
          : [],
      });
    }

    // サイトを作る（配信するサブドメインを決める）。デプロイは作ったあとにサイトの画面で選ぶ
    if (route === "POST /api/sites") {
      if (!isAdmin) return forbidden();
      const body = await readJson(req);
      const name = String(body?.name ?? "").trim().toLowerCase();
      if (!PROJECT_NAME.test(name)) return sendJson(res, 400, { error: "サイト名は英小文字・数字・ハイフンで 63 文字以内にしてください" });
      if (reservedLabels.has(name)) return sendJson(res, 400, { error: `${name} は管理画面で使っている名前なので、サイト名にできません` });
      if (sites.has(name)) return sendJson(res, 409, { error: `サイト ${name} は既にあります` });
      try {
        await sites.ensure(name);
      } catch (err) {
        if (err instanceof SettingsError) return sendJson(res, 400, { error: err.message });
        throw err;
      }
      return sendJson(res, 200, { name, ...siteInfo(name) });
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
      if (found && !canSite(found.name)) return forbidden();
      return found ? sendJson(res, 200, found) : sendJson(res, 404, { error: "デプロイが見つかりません" });
    }

    if (route === "POST /api/deploy-github/inspect") {
      const body = await readJson(req);
      const url = typeof body?.url === "string" ? body.url.trim() : "";
      if (!url) return sendJson(res, 400, { error: "GitHub の URL を入力してください" });
      try {
        const fetched = await fetchFromGitHub(url, { maxBytes: config.maxUploadBytes, ...github }, new DeployLog("inspect"));
        const { name, vars } = inspectFiles(fetched);
        // 取得したリポジトリの wrangler の設定だけを返す（ほかのサイトの情報は混ぜない）
        return sendJson(res, 200, { name, vars });
      } catch (err) {
        if (err instanceof GitHubError || err instanceof ConfigError) return sendJson(res, 400, { error: err.message });
        throw err;
      }
    }

    if (route === "GET /api/site-name") {
      // サイト名の空きを調べるのはサイトを作る管理者だけ（メンバーにほかのサイトの有無を見せない）
      if (!isAdmin) return forbidden();
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
      // メンバーは自分のサイトの再デプロイだけ（新しいサイトは作れない）
      if (!isAdmin && (!siteName || !canSite(siteName) || !sites.has(siteName))) return forbidden();
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
        // メンバーのサイトを自動でルートにしない（ルートは管理画面と同じオリジンで動くため）
        const result = await deployFromGitHub(url, deployer, { maxBytes: config.maxUploadBytes, ...github, siteName, autoRoot: isAdmin });
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

    const siteRoute = /^(GET|POST|PUT|DELETE) \/api\/sites\/([a-z0-9-]+)(\/.*)?$/.exec(route);
    if (!siteRoute) return sendJson(res, 404, { error: "Not Found" });
    const [, , name, rest = ""] = siteRoute;
    if (!canSite(name)) return forbidden();
    const store = sites.get(name);
    if (!store) return sendJson(res, 404, { error: "サイトが見つかりません" });
    // まだデプロイしていないサイトでは undefined
    const release = store.get();
    const siteRouteKey = `${method} ${rest}`;

    if (siteRouteKey === "GET " && !release) {
      return sendJson(res, 200, { name, ...siteUrls(name), root: sites.root === name, deployed: false, release: null, latest: history.latest(name) ?? null, repo: await repos.exists(name) });
    }

    if (siteRouteKey === "GET " && release) {
      const m = release.manifest;
      return sendJson(res, 200, {
        name,
        ...siteUrls(name),
        root: sites.root === name,
        deployed: true,
        repo: await repos.exists(name),
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
        wranglerVars: release?.manifest.vars ?? {},
        ...siteUrls(name),
      });
    }

    if (siteRouteKey === "PUT /settings") {
      const body = await readJson(req);
      const patch: SettingsPatch = envPatch(body);
      if (body && "subdomain" in body) patch.subdomain = body.subdomain === null ? null : String(body.subdomain ?? "");
      const wanted = typeof patch.subdomain === "string" ? patch.subdomain.trim().toLowerCase() : "";
      if (wanted && wanted !== sites.subdomain(name) && reservedLabels.has(wanted)) {
        return sendJson(res, 400, { error: `${wanted} は管理画面で使っているので、サブドメインにできません` });
      }
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

    // ---------- サイトのメンバーと招待（管理者） ----------

    if (siteRouteKey === "GET /members") {
      const invites = state.invites(name).map((i) => ({ id: i.id, createdAt: i.createdAt, expiresAt: i.expiresAt, createdBy: state.user(i.createdBy)?.name ?? null }));
      const members = state.users.filter((u) => u.role === "member" && u.sites.includes(name)).map((u) => ({ id: u.id, name: u.name, createdAt: u.createdAt }));
      return sendJson(res, 200, { members, invites });
    }

    if (siteRouteKey === "POST /invites") {
      const { token, invite } = await state.createInvite(name, user.id);
      return sendJson(res, 200, { id: invite.id, expiresAt: invite.expiresAt, ttlDays: INVITE_TTL_MS / 86_400_000, url: `${origin}${ADMIN_PATH}/#/invite/${token}` });
    }

    const inviteRevoke = /^DELETE \/invites\/([0-9a-f]+)$/.exec(siteRouteKey);
    if (inviteRevoke) {
      return (await state.revokeInvite(name, inviteRevoke[1])) ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: "招待が見つかりません" });
    }

    const memberRemove = /^DELETE \/members\/([^/]+)$/.exec(siteRouteKey);
    if (memberRemove) {
      try {
        await state.updateUser(decodeURIComponent(memberRemove[1]), { removeSite: name });
      } catch (err) {
        if (err instanceof UserError) return sendJson(res, 404, { error: err.message });
        throw err;
      }
      return sendJson(res, 200, { ok: true });
    }

    if (siteRouteKey === "DELETE ") {
      runtime.evict(store.siteDir);
      await state.removeSiteAccess(name);
      await sites.remove(name);
      // リポジトリはサイトに属するので一緒に消す（残すと次の起動で空のサイトとして戻ってくる）
      await repos.remove(name);
      history.clear(name);
      observability.clear(name);
      return sendJson(res, 200, { ok: true });
    }

    if (siteRouteKey === "GET /deployments") return sendJson(res, 200, { deployments: history.list(name), active: release?.id ?? null });

    const deployment = /^GET \/deployments\/([^/]+)$/.exec(siteRouteKey);
    if (deployment) {
      const found = history.get(decodeURIComponent(deployment[1]), name);
      return found ? sendJson(res, 200, found) : sendJson(res, 404, { error: "デプロイが見つかりません" });
    }

    // ---------- データベース（KV） ----------

    if (siteRouteKey === "GET /kv") return sendJson(res, 200, { namespaces: kvNamespaces(store.siteDir, release) });

    const kvRoute = /^(GET|PUT|DELETE) \/kv\/([^/]+)\/(keys|value)$/.exec(siteRouteKey);
    if (kvRoute) {
      const [, m, rawNs, what] = kvRoute;
      const ns = decodeURIComponent(rawNs);
      if (!BINDING_NAME.test(ns)) return sendJson(res, 400, { error: "KV の名前空間の名前が不正です" });
      const key = query.get("key") ?? "";
      if (m === "GET" && what === "keys") return sendJson(res, 200, kvKeys(store.siteDir, ns, query.get("prefix") ?? "", query.get("after") ?? ""));
      if (what === "value" && m === "GET") {
        const value = kvValue(store.siteDir, ns, key);
        return value ? sendJson(res, 200, value) : sendJson(res, 404, { error: "キーが見つかりません" });
      }
      try {
        if (what === "value" && m === "PUT") {
          const body = await readJson(req, 26 * 1024 * 1024);
          const ttl = body?.expirationTtl === null || body?.expirationTtl === undefined || body?.expirationTtl === "" ? undefined : Number(body.expirationTtl);
          await kvPut(store.siteDir, ns, String(body?.key ?? ""), String(body?.value ?? ""), { expirationTtl: ttl, metadata: body?.metadata ?? undefined });
          return sendJson(res, 200, { ok: true });
        }
        if (what === "value" && m === "DELETE") {
          await kvDelete(store.siteDir, ns, key);
          return sendJson(res, 200, { ok: true });
        }
      } catch (err) {
        if (err instanceof TypeError) return sendJson(res, 400, { error: err.message });
        throw err;
      }
    }

    // ---------- ストレージ（R2） ----------

    if (siteRouteKey === "GET /r2") return sendJson(res, 200, { buckets: r2Buckets(store.siteDir, release) });

    const r2Route = /^(GET|PUT|DELETE) \/r2\/([^/]+)\/(objects|object|preview)$/.exec(siteRouteKey);
    if (r2Route) {
      const [, m, rawBucket, what] = r2Route;
      const bucketName = decodeURIComponent(rawBucket);
      // バケット名はファイルのディレクトリ名になるので、wrangler と同じ規則で確かめる（../ などでサイトの外に出させない）
      if (!R2_BUCKET_NAME.test(bucketName)) return sendJson(res, 400, { error: "バケット名が不正です" });
      const key = query.get("key") ?? "";
      try {
        if (m === "GET" && what === "objects") return sendJson(res, 200, await r2List(store.siteDir, bucketName, query.get("prefix") ?? "", query.get("cursor") || undefined));
        const bucket = r2Bucket(store.siteDir, bucketName);
        if (m === "GET" && what === "preview") {
          const obj = (await bucket.get(key, { range: { offset: 0, length: PREVIEW_BYTES } })) as { size: number; arrayBuffer?: () => Promise<ArrayBuffer> } | null;
          if (!obj?.arrayBuffer) return sendJson(res, 404, { error: "オブジェクトが見つかりません" });
          const head = await bucket.head(key);
          return sendJson(res, 200, { text: asText(new Uint8Array(await obj.arrayBuffer())), size: head?.size ?? 0, truncated: (head?.size ?? 0) > PREVIEW_BYTES });
        }
        if (m === "GET" && what === "object") {
          const obj = (await bucket.get(key)) as { size: number; httpMetadata: { contentType?: string }; body?: ReadableStream<Uint8Array> } | null;
          if (!obj?.body) return sendJson(res, 404, { error: "オブジェクトが見つかりません" });
          // 管理画面と同じオリジンで開かれないよう、必ずダウンロードにする
          const filename = encodeURIComponent(key.split("/").pop() || "object");
          res.writeHead(200, {
            "content-type": "application/octet-stream",
            "content-length": String(obj.size),
            "content-disposition": `attachment; filename*=UTF-8''${filename}`,
            "x-content-type-options": "nosniff",
            "cache-control": "no-store",
          });
          for await (const chunk of obj.body) res.write(chunk);
          res.end();
          return;
        }
        if (m === "PUT" && what === "object") {
          const body = await readBody(req, config.maxUploadBytes);
          if (!body) return sendJson(res, 413, { error: `アップロードは ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB 以内にしてください` });
          const contentType = String(req.headers["x-object-content-type"] ?? "") || undefined;
          await bucket.put(key, body, { httpMetadata: contentType ? { contentType } : undefined });
          return sendJson(res, 200, { ok: true });
        }
        if (m === "DELETE" && what === "object") {
          await bucket.delete(key);
          return sendJson(res, 200, { ok: true });
        }
      } catch (err) {
        if (err instanceof TypeError || err instanceof RangeError) return sendJson(res, 400, { error: err.message });
        throw err;
      }
    }

    if ((siteRouteKey === "GET /files" || siteRouteKey === "GET /file") && !release) return sendJson(res, 404, { error: "まだデプロイされていません" });

    if (siteRouteKey === "GET /files" && release) return sendJson(res, 200, { release: release.id, groups: listFiles(release) });

    if (siteRouteKey === "GET /file" && release) {
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
