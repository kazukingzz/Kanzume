import fs from "node:fs";
import path from "node:path";
import type { Release } from "../store.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
};

export function assetsDir(release: Release): string {
  return path.join(release.dir, "assets");
}

function decodePath(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.split("/").includes("..")) return null;
  return decoded;
}

function stat(root: string, p: string): fs.Stats | null {
  try {
    const s = fs.statSync(path.join(root, p));
    return s.isFile() ? s : null;
  } catch {
    return null;
  }
}

function redirect(location: string, search: string): Response {
  return new Response(null, { status: 307, headers: { location: location + search } });
}

async function file(request: Request, root: string, p: string, s: fs.Stats, status = 200): Promise<Response> {
  const etag = `"${s.size.toString(36)}-${Math.floor(s.mtimeMs).toString(36)}"`;
  const headers = new Headers({
    "content-type": MIME[path.extname(p).toLowerCase()] ?? "application/octet-stream",
    "cache-control": "public, max-age=0, must-revalidate",
    etag,
  });
  if (status === 200 && request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  if (request.method === "HEAD") {
    headers.set("content-length", String(s.size));
    return new Response(null, { status, headers });
  }
  return new Response(await fs.openAsBlob(path.join(root, p)), { status, headers });
}

export async function matchAsset(release: Release, request: Request): Promise<Response | null> {
  const assets = release.manifest.assets;
  if (!assets) return null;
  const url = new URL(request.url);
  const p = decodePath(url.pathname);
  if (p === null) return null;
  const root = assetsDir(release);
  const found = (candidate: string) => stat(root, candidate);

  if (assets.htmlHandling === "none") {
    const s = found(p);
    return s ? file(request, root, p, s) : null;
  }

  const dropSlash = assets.htmlHandling === "drop-trailing-slash";
  const forceSlash = assets.htmlHandling === "force-trailing-slash";

  if (p.endsWith("/")) {
    const index = `${p}index.html`;
    const base = p.slice(0, -1);
    const indexStat = found(index);
    if (indexStat) return dropSlash && p !== "/" ? redirect(base, url.search) : file(request, root, index, indexStat);
    if (p !== "/" && found(`${base}.html`)) {
      return forceSlash ? file(request, root, `${base}.html`, found(`${base}.html`)!) : redirect(base, url.search);
    }
    return null;
  }

  if (p.endsWith("/index.html") && found(p)) return redirect(p.slice(0, -"index.html".length), url.search);
  if (p.endsWith(".html") && found(p)) return redirect(p.slice(0, -".html".length) + (forceSlash ? "/" : ""), url.search);

  const exact = found(p);
  if (exact) return file(request, root, p, exact);
  const html = found(`${p}.html`);
  if (html) return forceSlash ? redirect(`${p}/`, url.search) : file(request, root, `${p}.html`, html);
  const index = found(`${p}/index.html`);
  if (index) return dropSlash ? file(request, root, `${p}/index.html`, index) : redirect(`${p}/`, url.search);
  return null;
}

export async function notFoundAsset(release: Release, request: Request): Promise<Response | null> {
  const assets = release.manifest.assets;
  if (!assets) return null;
  const root = assetsDir(release);
  if (assets.notFoundHandling === "single-page-application") {
    const s = stat(root, "/index.html");
    return s ? file(request, root, "/index.html", s) : null;
  }
  if (assets.notFoundHandling === "404-page") {
    let dir = path.posix.dirname(decodePath(new URL(request.url).pathname) ?? "/");
    while (true) {
      const candidate = path.posix.join(dir, "404.html");
      const s = stat(root, candidate);
      if (s) return file(request, root, candidate, s, 404);
      if (dir === "/" || dir === ".") return null;
      dir = path.posix.dirname(dir);
    }
  }
  return null;
}

export async function serveAssets(release: Release, request: Request): Promise<Response> {
  return (
    (await matchAsset(release, request)) ??
    (await notFoundAsset(release, request)) ??
    new Response("Not Found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } })
  );
}

export class AssetsBinding {
  #release: Release;

  constructor(release: Release) {
    this.#release = release;
  }

  async fetch(input: Request | string | URL, init?: RequestInit): Promise<Response> {
    const request = typeof input === "string" || input instanceof URL ? new Request(new URL(input, "http://assets.local"), init) : input;
    return serveAssets(this.#release, request);
  }
}
