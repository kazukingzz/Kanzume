import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export function externalOrigin(req: IncomingMessage, configured: string | undefined): string {
  if (configured) return configured;
  const proto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() || "http";
  return `${proto}://${req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost"}`;
}

export function clientIp(req: IncomingMessage): string {
  const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
  return forwarded || req.socket.remoteAddress || "";
}

export function toWebRequest(req: IncomingMessage, url: string, extraHeaders: Record<string, string> = {}): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined || key.startsWith(":")) continue;
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
  if (!response.body || method === "HEAD" || response.status === 204 || response.status === 304) {
    await response.body?.cancel().catch(() => {});
    res.end();
    return;
  }
  await pipeline(Readable.fromWeb(response.body as never), res).catch(() => {
    res.destroy();
  });
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
