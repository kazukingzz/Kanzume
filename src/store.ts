import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type HtmlHandling = "auto-trailing-slash" | "force-trailing-slash" | "drop-trailing-slash" | "none";
export type NotFoundHandling = "none" | "single-page-application" | "404-page";

export interface Manifest {
  name: string;
  main: string | null;
  compatibilityDate: string | null;
  compatibilityFlags: string[];
  vars: Record<string, unknown>;
  kvNamespaces: { binding: string }[];
  r2Buckets: { binding: string; bucketName: string }[];
  assets: {
    binding: string | null;
    htmlHandling: HtmlHandling;
    notFoundHandling: NotFoundHandling;
    runWorkerFirst: boolean | string[];
  } | null;
}

export interface Release {
  id: string;
  dir: string;
  deployedAt: string;
  manifest: Manifest;
}

export interface UploadedFile {
  path: string;
  data: Buffer;
}

const MANIFEST_FILE = "_manifest.json";
const KEEP_RELEASES = 3;

export const PROJECT_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export class Store {
  readonly siteDir: string;
  #releasesDir: string;
  #current: Release | undefined;

  constructor(dataDir: string) {
    this.siteDir = path.join(dataDir, "site");
    this.#releasesDir = path.join(this.siteDir, "releases");
  }

  async init(): Promise<void> {
    await fs.mkdir(this.#releasesDir, { recursive: true });
    const id = await fs.readFile(path.join(this.siteDir, "current"), "utf8").catch(() => null);
    if (id) this.#current = await this.#readRelease(id.trim()).catch(() => undefined);
  }

  get(): Release | undefined {
    return this.#current;
  }

  async createRelease(manifest: Manifest, files: UploadedFile[]): Promise<Release> {
    const id = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    const tmp = path.join(this.#releasesDir, `${id}.tmp`);
    await fs.mkdir(tmp, { recursive: true });
    try {
      for (const file of files) {
        const dest = path.join(tmp, file.path);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, file.data);
      }
      const deployedAt = new Date().toISOString();
      await fs.writeFile(path.join(tmp, MANIFEST_FILE), JSON.stringify({ deployedAt, manifest }));
      const dir = path.join(this.#releasesDir, id);
      await fs.rename(tmp, dir);
      return { id, dir, deployedAt, manifest };
    } catch (err) {
      await fs.rm(tmp, { recursive: true, force: true });
      throw err;
    }
  }

  async activate(release: Release): Promise<void> {
    const tmp = path.join(this.siteDir, `current.${release.id}.tmp`);
    await fs.writeFile(tmp, release.id);
    await fs.rename(tmp, path.join(this.siteDir, "current"));
    this.#current = release;
    await this.#prune();
  }

  async discard(release: Release): Promise<void> {
    await fs.rm(release.dir, { recursive: true, force: true });
  }

  async remove(): Promise<void> {
    this.#current = undefined;
    await fs.rm(this.siteDir, { recursive: true, force: true });
    await fs.mkdir(this.#releasesDir, { recursive: true });
  }

  async #readRelease(id: string): Promise<Release> {
    const dir = path.join(this.#releasesDir, id);
    const { deployedAt, manifest } = JSON.parse(await fs.readFile(path.join(dir, MANIFEST_FILE), "utf8"));
    return { id, dir, deployedAt, manifest };
  }

  async #prune(): Promise<void> {
    const active = this.#current?.id;
    const ids = (await fs.readdir(this.#releasesDir)).filter((id) => !id.endsWith(".tmp")).sort().reverse();
    for (const id of ids.slice(KEEP_RELEASES)) {
      if (id !== active) await fs.rm(path.join(this.#releasesDir, id), { recursive: true, force: true });
    }
  }
}
