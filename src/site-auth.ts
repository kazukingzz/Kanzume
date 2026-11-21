/**
 * サイトのログイン（パスキー）。ログインを必須にしたサイトは、管理画面で登録したパスキーでログインしないと開けない。
 * - パスキーはルートドメインに紐づける（RP ID）。管理画面（登録）とサイト（ログイン）がどちらもそのドメインかサブドメインにあるため
 * - ログインの状態は、サイトの秘密鍵で署名した Cookie で持つ（サイトのホストだけに付く）
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Challenges } from "./admin/session.ts";
import { readBody, requestOrigin, sendJson, sendText } from "./http.ts";
import type { Sites } from "./sites.ts";

export interface SitePasskey {
  id: string;
  publicKey: string;
  counter: number;
  transports?: string[];
  createdAt: string;
  name: string;
}

export interface SiteAccess {
  /** ログインの Cookie の署名に使う。ログインをやめると消える（作り直すと前の Cookie は使えない） */
  secret: string;
  passkeys: SitePasskey[];
}

export const SITE_LOGIN_PATH = "/_kanzume/login";
export const SITE_SESSION_COOKIE = "kanzume_site_session";
export const SITE_SESSION_MAX_AGE = 30 * 24 * 60 * 60;

const webauthn = () => import("@simplewebauthn/server");

export const newSiteAccessSecret = () => randomBytes(32).toString("base64url");

/**
 * settings.json の access。手で書き換えられて壊れていても、ログインなし（誰でも見られる）にはしない。
 * 読めるパスキーだけを残し、1 つもなければ誰も入れない（管理画面でログインをやめるか、パスキーを登録し直す）
 */
export function parseSiteAccess(raw: unknown): SiteAccess | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const { secret, passkeys } = raw as Record<string, unknown>;
  const valid = (Array.isArray(passkeys) ? passkeys : []).filter(
    (p): p is SitePasskey => !!p && typeof p.id === "string" && typeof p.publicKey === "string" && typeof p.counter === "number",
  );
  return {
    secret: typeof secret === "string" && secret ? secret : newSiteAccessSecret(),
    passkeys: valid.map((p) => ({ ...p, name: typeof p.name === "string" ? p.name : "" })),
  };
}

const hostname = (host: string) => host.toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");

/** パスキーの RP ID（ルートドメインのホスト名） */
export const siteRpId = (rootHost: string) => hostname(rootHost);

/** そのホストで RP ID のパスキーを使えるか（RP ID と同じか、そのサブドメイン） */
export const usableOn = (host: string, rpId: string) => {
  const h = hostname(host);
  return h === rpId || h.endsWith(`.${rpId}`);
};

const sign = (secret: string, site: string, credentialId: string, issued: string) =>
  createHmac("sha256", secret).update(`${site}\n${credentialId}\n${issued}`).digest("base64url");

export function createSiteSession(access: SiteAccess, site: string, credentialId: string, now = Date.now()): string {
  const issued = String(now);
  return `${credentialId}.${issued}.${sign(access.secret, site, credentialId, issued)}`;
}

/** 署名が合い、期限内で、そのパスキーがまだ登録されているか */
export function checkSiteSession(access: SiteAccess, site: string, token: string, now = Date.now()): boolean {
  const [credentialId, issued, mac, extra] = token.split(".");
  if (!credentialId || !issued || !mac || extra !== undefined || !/^\d+$/.test(issued)) return false;
  const age = now - Number(issued);
  if (age < 0 || age > SITE_SESSION_MAX_AGE * 1000) return false;
  const expected = Buffer.from(sign(access.secret, site, credentialId, issued));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;
  return access.passkeys.some((p) => p.id === credentialId);
}

/** 同じ名前の Cookie をすべて（親ドメインに付けた同名の Cookie があっても、本物を見落とさない） */
function cookieValues(req: IncomingMessage, name: string): string[] {
  const out: string[] = [];
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name) out.push(part.slice(eq + 1).trim());
  }
  return out;
}

const sessionCookie = (req: IncomingMessage, value: string) =>
  `${SITE_SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SITE_SESSION_MAX_AGE}${requestOrigin(req).startsWith("https:") ? "; Secure" : ""}`;

/** ログインのあとに戻る先。同じサイトのパスだけ（//evil.example や /\evil.example のような別のホストへは戻さない） */
export function safeNext(next: unknown): string {
  // ブラウザは URL のタブ・改行を取り除くので、/<TAB>/evil.example も //evil.example として別のホストへ飛ぶ。空白・制御文字・\ は一切通さない
  if (typeof next !== "string" || !/^\/(?!\/)/.test(next) || /[\s\x00-\x1f\x7f\\]/.test(next)) return "/";
  const url = new URL(next, "http://kanzume.invalid");
  return url.host === "kanzume.invalid" ? `${url.pathname}${url.search}${url.hash}` : "/";
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function loginPage(site: string): string {
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>ログイン</title>
<body style="font-family:system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;color:#1d1d1b;background:#f6f6f4">
<main style="padding:16px;text-align:center;max-width:360px"><h1 style="font-size:20px">${escapeHtml(site)}</h1><p>このサイトを開くにはログインが必要です。</p>
<button id="login" style="font:inherit;padding:10px 20px;border-radius:8px;border:1px solid #1d1d1b;background:#1d1d1b;color:#fff;cursor:pointer">パスキーでログイン</button>
<p id="error" style="color:#b91c1c;min-height:1.5em"></p></main>
<script>
const b64ToBuf = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0)).buffer;
const bufToB64 = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
const post = async (path, body) => {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "ログインできませんでした");
  return data;
};
document.getElementById("login").addEventListener("click", async () => {
  const error = document.getElementById("error");
  error.textContent = "";
  try {
    const json = await post("${SITE_LOGIN_PATH}/options", {});
    const publicKey = PublicKeyCredential.parseRequestOptionsFromJSON
      ? PublicKeyCredential.parseRequestOptionsFromJSON(json)
      : { ...json, challenge: b64ToBuf(json.challenge), allowCredentials: (json.allowCredentials || []).map((c) => ({ ...c, id: b64ToBuf(c.id) })) };
    const cred = await navigator.credentials.get({ publicKey });
    const r = cred.response;
    const response = typeof cred.toJSON === "function" ? cred.toJSON() : {
      id: cred.id, rawId: bufToB64(cred.rawId), type: cred.type, clientExtensionResults: cred.getClientExtensionResults(),
      response: { clientDataJSON: bufToB64(r.clientDataJSON), authenticatorData: bufToB64(r.authenticatorData), signature: bufToB64(r.signature), ...(r.userHandle ? { userHandle: bufToB64(r.userHandle) } : {}) },
    };
    const { next } = await post("${SITE_LOGIN_PATH}/verify", { response, next: new URLSearchParams(location.search).get("next") });
    const target = new URL(next, location.origin);
    location.replace(target.origin === location.origin ? target.href : "/");
  } catch (err) {
    error.textContent = err.name === "NotAllowedError" ? "ログインを中止しました" : err.message;
  }
});
</script></body></html>`;
}

export class SiteAuth {
  #sites: Sites;
  #challenges = new Challenges();

  constructor(sites: Sites) {
    this.#sites = sites;
  }

  /**
   * ログインを必須にしたサイトへのリクエストを受ける。ログイン画面・ログインの API・ログインしていないリクエストに
   * 応答したら true（サイトには渡さない）。ログインを必須にしていないか、ログインしていれば false
   */
  async gate(req: IncomingMessage, res: ServerResponse, site: string, pathname: string, search: string, rpId: string): Promise<boolean> {
    const access = this.#sites.settings(site).access;
    if (!access) return false;
    const method = req.method ?? "GET";
    if (pathname === SITE_LOGIN_PATH && (method === "GET" || method === "HEAD")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(method === "HEAD" ? undefined : loginPage(site));
      return true;
    }
    if (pathname === `${SITE_LOGIN_PATH}/options` && method === "POST") {
      const options = (await webauthn()).generateAuthenticationOptions({
        rpID: rpId,
        challenge: this.#challenges.create("site-login"),
        allowCredentials: access.passkeys.map((p) => ({ id: p.id, transports: p.transports as never })),
        userVerification: "preferred",
      });
      sendJson(res, 200, await options);
      return true;
    }
    if (pathname === `${SITE_LOGIN_PATH}/verify` && method === "POST") {
      await this.#verify(req, res, site, rpId);
      return true;
    }
    if (cookieValues(req, SITE_SESSION_COOKIE).some((token) => checkSiteSession(access, site, token))) return false;

    const accept = String(req.headers.accept ?? "");
    if ((method === "GET" || method === "HEAD") && accept.includes("text/html")) {
      res.writeHead(302, { location: `${SITE_LOGIN_PATH}?next=${encodeURIComponent(`${pathname}${search}`)}`, "cache-control": "no-store" });
      res.end();
    } else {
      sendText(res, 401, "ログインが必要です", { "cache-control": "no-store" });
    }
    return true;
  }

  async #verify(req: IncomingMessage, res: ServerResponse, site: string, rpId: string): Promise<void> {
    const raw = await readBody(req, 256 * 1024);
    let body: { response?: { id?: unknown }; next?: unknown } = {};
    try {
      body = raw ? JSON.parse(raw.toString("utf8")) : {};
    } catch {}
    const access = this.#sites.settings(site).access;
    const stored = access?.passkeys.find((p) => p.id === body?.response?.id);
    if (!access || !stored) return sendJson(res, 400, { error: "このサイトに登録されていないパスキーです" });
    let challenge = "";
    let result: Awaited<ReturnType<Awaited<ReturnType<typeof webauthn>>["verifyAuthenticationResponse"]>>;
    try {
      result = await (await webauthn()).verifyAuthenticationResponse({
        response: body.response as never,
        expectedChallenge: (c) => {
          challenge = c;
          return this.#challenges.claim(c, "site-login");
        },
        expectedOrigin: requestOrigin(req),
        expectedRPID: rpId,
        credential: { id: stored.id, publicKey: Buffer.from(stored.publicKey, "base64url"), counter: stored.counter, transports: stored.transports as never },
        requireUserVerification: false,
      });
    } catch (err) {
      this.#challenges.release(challenge);
      return sendJson(res, 400, { error: (err as Error).message });
    }
    if (!result.verified) {
      this.#challenges.release(challenge);
      return sendJson(res, 400, { error: "パスキーを検証できませんでした" });
    }
    this.#challenges.markUsed(challenge);
    const counter = result.authenticationInfo.newCounter;
    // 同期するパスキー（iCloud キーチェーンなど）は常に 0 なので、変わったときだけ書く
    if (counter !== stored.counter) {
      await this.#sites.updateAccess(
        site,
        (current) => current && { ...current, passkeys: current.passkeys.map((p) => (p.id === stored.id ? { ...p, counter } : p)) },
      );
    }
    sendJson(res, 200, { ok: true, next: safeNext(body.next) }, { "set-cookie": sessionCookie(req, createSiteSession(access, site, stored.id)) });
  }
}
