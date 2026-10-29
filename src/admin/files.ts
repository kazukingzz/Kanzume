import fs from "node:fs";
import path from "node:path";
import { CONFIG_FILES } from "../deploy/wrangler.ts";
import type { Release } from "../store.ts";

export type FileGroup = "source" | "config" | "worker" | "assets";

export interface FileEntry {
  path: string;
  size: number;
}

const MAX_VIEW_BYTES = 1024 * 1024;

function walk(root: string, rel = ""): FileEntry[] {
  const dir = path.join(root, rel);
  if (!fs.existsSync(dir)) return [];
  const out: FileEntry[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(root, p));
    else if (entry.isFile()) out.push({ path: p, size: fs.statSync(path.join(root, p)).size });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function sources(release: Release): { path: string; content: string }[] {
  try {
    return JSON.parse(fs.readFileSync(path.join(release.dir, "_sources.json"), "utf8"));
  } catch {
    return [];
  }
}

export function listFiles(release: Release): Record<FileGroup, FileEntry[]> {
  return {
    source: sources(release)
      .map((s) => ({ path: s.path, size: Buffer.byteLength(s.content) }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    config: CONFIG_FILES.filter((f) => fs.existsSync(path.join(release.dir, f))).map((f) => ({
      path: f,
      size: fs.statSync(path.join(release.dir, f)).size,
    })),
    worker: walk(path.join(release.dir, "worker")),
    assets: walk(path.join(release.dir, "assets")),
  };
}

export interface FileContent {
  path: string;
  size: number;
  binary: boolean;
  truncated: boolean;
  text: string | null;
}

function toContent(p: string, data: Buffer): FileContent {
  const head = data.subarray(0, 8192);
  if (head.includes(0)) return { path: p, size: data.length, binary: true, truncated: false, text: null };
  const truncated = data.length > MAX_VIEW_BYTES;
  return { path: p, size: data.length, binary: false, truncated, text: data.subarray(0, MAX_VIEW_BYTES).toString("utf8") };
}

export function readFile(release: Release, group: FileGroup, p: string): FileContent | null {
  if (group === "source") {
    const found = sources(release).find((s) => s.path === p);
    return found ? toContent(p, Buffer.from(found.content)) : null;
  }
  if (group === "config") {
    if (!(CONFIG_FILES as readonly string[]).includes(p)) return null;
    const file = path.join(release.dir, p);
    return fs.existsSync(file) ? toContent(p, fs.readFileSync(file)) : null;
  }
  const root = path.join(release.dir, group);
  const file = path.resolve(root, p);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  return toContent(p, fs.readFileSync(file));
}
