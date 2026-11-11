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
  /** KV / R2 のデータを置くサイトのディレクトリ */
  siteDir: string;
  deployedAt: string;
  manifest: Manifest;
}

export interface UploadedFile {
  path: string;
  data: Buffer;
}

const MANIFEST_FILE = "_manifest.json";
const KEEP_RELEASES = 3;

const exists = (p: string) =>
  fs.lstat(p).then(
    () => true,
    () => false,
  );

export const PROJECT_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * base の下に rel のディレクトリを 1 段ずつ作る。recursive と違い、base（やサイトのディレクトリ）が消されていたら
 * 作り直さずに ENOENT になる（デプロイ中にサイトを消されても、サイトを生き返らせない）
 */
async function mkdirUnder(base: string, rel: string, mode: number): Promise<void> {
  let dir = base;
  for (const part of rel.split("/").filter(Boolean)) {
    dir = path.join(dir, part);
    await fs.mkdir(dir, { mode }).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "EEXIST") throw err;
    });
  }
}

export class Store {
  readonly siteDir: string;
  #releasesDir: string;
  #current: Release | undefined;

  constructor(siteDir: string) {
    this.siteDir = siteDir;
    this.#releasesDir = path.join(this.siteDir, "releases");
  }

  async init(): Promise<void> {
    await fs.mkdir(this.#releasesDir, { recursive: true });
    // 以前の置き場所（サイトのディレクトリの直下）の KV / R2 を data/ に移す。失敗してもほかは読み込む（起動を止めない）
    const data = path.join(this.siteDir, "data");
    for (const name of ["data.sqlite", "data.sqlite-wal", "data.sqlite-shm", "r2"]) {
      const from = path.join(this.siteDir, name);
      const to = path.join(data, name);
      try {
        if (!(await exists(from)) || (await exists(to))) continue;
        await fs.mkdir(data, { recursive: true });
        await fs.rename(from, to);
      } catch (err) {
        console.error(`[store] ${from} を data/ に移せませんでした:`, (err as Error)?.message ?? err);
      }
    }
    const id = await fs.readFile(path.join(this.siteDir, "current"), "utf8").catch(() => null);
    if (id) this.#current = await this.#readRelease(id.trim()).catch(() => undefined);
  }

  get(): Release | undefined {
    return this.#current;
  }

  async createRelease(manifest: Manifest, files: UploadedFile[]): Promise<Release> {
    const id = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    const tmp = path.join(this.#releasesDir, `${id}.tmp`);
    // リリースと current は、Worker の子プロセス（サイトのグループ）からは読むだけにする（書き換えさせない）
    await fs.mkdir(tmp, { mode: 0o750 }).catch((err: NodeJS.ErrnoException) => {
      throw err.code === "ENOENT" ? new Error("サイトが削除されました") : err;
    });
    try {
      for (const file of files) {
        await mkdirUnder(tmp, path.posix.dirname(file.path), 0o750);
        await fs.writeFile(path.join(tmp, file.path), file.data, { mode: 0o640 });
      }
      const deployedAt = new Date().toISOString();
      await fs.writeFile(path.join(tmp, MANIFEST_FILE), JSON.stringify({ deployedAt, manifest }), { mode: 0o640 });
      const dir = path.join(this.#releasesDir, id);
      await fs.rename(tmp, dir);
      return { id, dir, siteDir: this.siteDir, deployedAt, manifest };
    } catch (err) {
      await fs.rm(tmp, { recursive: true, force: true });
      throw err;
    }
  }

  /** onSwitch は配信するリリースを切り替えたのと同じタイミングで（間に await を挟まずに）呼ぶ */
  async activate(release: Release, onSwitch?: () => void): Promise<void> {
    const tmp = path.join(this.siteDir, `current.${release.id}.tmp`);
    await fs.writeFile(tmp, release.id, { mode: 0o640 });
    await fs.rename(tmp, path.join(this.siteDir, "current"));
    this.#current = release;
    onSwitch?.();
    // ここまでで切り替えは済んでいる。古いリリースの掃除に失敗しても、デプロイは成功のままにする（次の掃除でまた消す）
    await this.#prune().catch((err) =>
      console.error(`[store] 古いリリースを消せませんでした（${path.basename(this.siteDir)}）:`, (err as Error)?.message ?? err),
    );
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
    return { id, dir, siteDir: this.siteDir, deployedAt, manifest };
  }

  async #prune(): Promise<void> {
    const active = this.#current?.id;
    const ids = (await fs.readdir(this.#releasesDir))
      .filter((id) => !id.endsWith(".tmp"))
      .sort()
      .reverse();
    for (const id of ids.slice(KEEP_RELEASES)) {
      if (id !== active) await fs.rm(path.join(this.#releasesDir, id), { recursive: true, force: true });
    }
  }
}
