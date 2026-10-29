import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
// @ts-expect-error 型定義のない .mjs
import { esbuildArgs } from "../action/cjs.mjs";
import { Store, type Manifest, type Release } from "../src/store.ts";

export function tmpDir(t: { after(fn: () => void): void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kanzume-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function writeTree(root: string, files: Record<string, string | Buffer>): void {
  for (const [rel, data] of Object.entries(files)) {
    const dest = path.join(root, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
  }
}

export function tarGz(t: { after(fn: () => void): void }, files: Record<string, string | Buffer>): Buffer {
  const dir = tmpDir(t);
  const src = path.join(dir, "src");
  writeTree(src, files);
  const out = path.join(dir, "out.tar.gz");
  execFileSync("tar", ["-czf", out, "-C", src, "."], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  return fs.readFileSync(out);
}

function octal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, "0") + "\0";
}

export function rawTarEntry(name: string, data: Buffer, type = "0", linkname = ""): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  header.write(octal(0o644, 8), 100);
  header.write(octal(0, 8), 108);
  header.write(octal(0, 8), 116);
  header.write(octal(data.length, 12), 124);
  header.write(octal(0, 12), 136);
  header.write("        ", 148);
  header.write(type, 156);
  header.write(linkname, 157, 100);
  header.write("ustar\0", 257);
  header.write("00", 263);
  let sum = 0;
  for (const b of header) sum += b;
  header.write(octal(sum, 7) + " ", 148);
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header, data, padding]);
}

export function rawTar(entries: Buffer[]): Buffer {
  return Buffer.concat([...entries, Buffer.alloc(1024)]);
}

export function rawTarGz(entries: Buffer[]): Buffer {
  return gzipSync(rawTar(entries));
}

export function manifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    name: "demo",
    main: "index.cjs",
    compatibilityDate: "2026-10-01",
    compatibilityFlags: [],
    vars: {},
    kvNamespaces: [],
    r2Buckets: [],
    assets: null,
    ...overrides,
  };
}

export async function release(
  t: { after(fn: () => void): void },
  m: Manifest,
  files: Record<string, string>,
): Promise<{ store: Store; release: Release; dataDir: string }> {
  const dataDir = tmpDir(t);
  const store = new Store(dataDir);
  await store.init();
  const r = await store.createRelease(
    m,
    Object.entries(files).map(([p, d]) => ({ path: p, data: Buffer.from(d) })),
  );
  await store.activate(r);
  return { store, release: r, dataDir };
}

const ESBUILD = path.join(import.meta.dirname, "..", "node_modules", ".bin", "esbuild");

/** worker/index.js（ESM）を Action と同じ手順で worker/index.cjs に変換する */
export function toCjs(t: { after(fn: () => void): void }, files: Record<string, string>): Record<string, string> {
  const dir = tmpDir(t);
  writeTree(dir, files);
  const out = path.join(dir, "out.cjs");
  execFileSync(ESBUILD, esbuildArgs(path.join(dir, "worker", "index.js"), out), { stdio: "pipe" });
  const result: Record<string, string> = { "worker/index.cjs": fs.readFileSync(out, "utf8") };
  for (const [p, d] of Object.entries(files)) if (!p.endsWith(".js")) result[p] = d;
  return result;
}
