import type { IncomingMessage, ServerResponse } from "node:http";
import { BlockList, isIPv4, isIPv6 } from "node:net";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { NULL_BODY_STATUS } from "./runtime/protocol.ts";

/**
 * X-Forwarded-* を信じるか（KANZUME_TRUST_PROXY）。auto（既定）は、直接つないできた相手がループバック・プライベートなどの
 * 内側のアドレスのときだけ信じる。Railway・Render・Docker・同じホストのリバースプロキシは内側のアドレスからつなぐので、そのまま動く。
 * インターネットから直接受けるときは、訪問者が書いた X-Forwarded-For で IP を偽れないようにする
 */
export type TrustProxy = "auto" | "always" | "never";

let trustProxy: TrustProxy = "auto";

export function setTrustProxy(mode: TrustProxy): void {
  trustProxy = mode;
}

const INTERNAL = new BlockList();
for (const [net, prefix] of [
  ["127.0.0.0", 8],
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["169.254.0.0", 16],
  // キャリアグレード NAT（Railway などの内部ネットワーク）
  ["100.64.0.0", 10],
] as const) {
  INTERNAL.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
] as const) {
  INTERNAL.addSubnet(net, prefix, "ipv6");
}

/** 直接つないできた相手が、X-Forwarded-* を信じてよいプロキシか */
export function fromTrustedProxy(req: IncomingMessage): boolean {
  if (trustProxy !== "auto") return trustProxy === "always";
  const addr = req.socket.remoteAddress ?? "";
  const v4 = addr.startsWith("::ffff:") ? addr.slice(7) : addr;
  if (isIPv4(v4)) return INTERNAL.check(v4, "ipv4");
  return isIPv6(addr) && INTERNAL.check(addr, "ipv6");
}

/** リクエストされたホスト（信じてよいプロキシからなら X-Forwarded-Host） */
export function requestHost(req: IncomingMessage): string {
  const forwarded = fromTrustedProxy(req) ? req.headers["x-forwarded-host"] : undefined;
  return String(forwarded ?? req.headers.host ?? "");
}

/** リクエストされたホストのオリジン */
export function requestOrigin(req: IncomingMessage): string {
  const proto =
    String((fromTrustedProxy(req) && req.headers["x-forwarded-proto"]) || "")
      .split(",")[0]
      .trim() || "http";
  return `${proto}://${requestHost(req) || "localhost"}`;
}

/**
 * ルートドメインのオリジン（サイトの URL を作る基準）。
 * KANZUME_ORIGIN → 管理画面で設定したドメイン → リクエストされたホストの順に決める
 */
export function rootOrigin(req: IncomingMessage, configured: string | undefined, domain: string | null): string {
  if (configured) return configured;
  if (domain) return `${requestOrigin(req).split("://")[0]}://${domain}`;
  return requestOrigin(req);
}

/** 決まっているルートドメインのホスト（KANZUME_ORIGIN か管理画面の設定）。どちらもなければ undefined（ホスト名から推測する） */
export function configuredRootHost(configured: string | undefined, domain: string | null): string | undefined {
  return configured ? new URL(configured).host : (domain ?? undefined);
}

/** サイトのオリジン（`https://<name>.<ルートドメイン>`） */
export function siteOrigin(rootOrigin: string, name: string): string {
  const url = new URL(rootOrigin);
  return `${url.protocol}//${name}.${url.host}`;
}

/**
 * 訪問者の IP（Worker の cf-connecting-ip）。X-Forwarded-For の先頭は訪問者が自由に書けるので、
 * 手前のプロキシ（Railway・Render など）が最後に足した値を使う。信じてよいプロキシからでなければ接続元のアドレス
 */
export function clientIp(req: IncomingMessage): string {
  if (!fromTrustedProxy(req)) return req.socket.remoteAddress || "";
  const forwarded = String(req.headers["x-forwarded-for"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .at(-1);
  return forwarded || req.socket.remoteAddress || "";
}

/** signal: 訪問者が離れたときに中止を伝える（子プロセスの Worker へのリクエストを切るため） */
export function toWebRequest(req: IncomingMessage, url: string, extraHeaders: Record<string, string> = {}, signal?: AbortSignal): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    // cf-connecting-ip など cf- で始まるものは Cloudflare が付けるヘッダーで、Worker はそれを信じる。訪問者が書いたものは渡さない
    if (value === undefined || key.startsWith(":") || key.startsWith("cf-")) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(key, v);
    else headers.set(key, value);
  }
  for (const [key, value] of Object.entries(extraHeaders)) headers.set(key, value);
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(url, {
    method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
    duplex: "half",
    redirect: "manual",
    signal,
  } as RequestInit);
}

export async function sendWebResponse(res: ServerResponse, response: Response, method: string | undefined): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  for (const [key, value] of response.headers) {
    if (key === "set-cookie") continue;
    headers[key] = value;
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers["set-cookie"] = cookies;
  res.writeHead(response.status, response.statusText || undefined, headers);
  if (!response.body || method === "HEAD" || NULL_BODY_STATUS.has(response.status)) {
    await response.body?.cancel().catch(() => {});
    res.end();
    return;
  }
  await pipeline(Readable.fromWeb(response.body as never), res).catch(() => {
    res.destroy();
  });
}

/**
 * リクエストのトークン。Bearer か、git の Basic 認証のパスワード（ユーザー名は何でもよい。ユーザー名だけに入れても通す）
 */
export function requestToken(req: IncomingMessage): string {
  const auth = req.headers.authorization ?? "";
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
  if (!auth.startsWith("Basic ")) return "";
  const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
  const i = decoded.indexOf(":");
  return i === -1 ? decoded : decoded.slice(i + 1) || decoded.slice(0, i);
}

export function sendText(res: ServerResponse, status: number, text: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", ...headers });
  res.end(text);
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

export async function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  const declared = Number(req.headers["content-length"]);
  if (declared > limit) return null;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown> | null> {
  const body = await readBody(req, limit);
  if (!body) return null;
  try {
    const value = JSON.parse(body.toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}
