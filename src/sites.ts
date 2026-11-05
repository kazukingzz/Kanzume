import fs from "node:fs/promises";
import path from "node:path";
import { closeSiteDb } from "./bindings/db.ts";
import { siteOrigin } from "./http.ts";
import { PROJECT_NAME, Store } from "./store.ts";

const ROOT_FILE = "_root";

/**
 * サイトはサブドメインで分ける（`blog.example.com` → `blog`）。データは `<dataDir>/sites/<name>/` に置くので、
 * KV / R2 はサイトごとに別の sqlite とディレクトリになる。
 */
export class Sites {
  readonly dir: string;
  #stores = new Map<string, Store>();
  #root: string | null = null;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, "sites");
  }

  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    for (const entry of await fs.readdir(this.dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !PROJECT_NAME.test(entry.name)) continue;
      const store = new Store(path.join(this.dir, entry.name));
      await store.init();
      this.#stores.set(entry.name, store);
    }
    const root = (await fs.readFile(path.join(this.dir, ROOT_FILE), "utf8").catch(() => "")).trim();
    this.#root = root && this.#stores.has(root) ? root : null;
  }

  has(name: string): boolean {
    return this.#stores.has(name);
  }

  get(name: string): Store | undefined {
    return this.#stores.get(name);
  }

  /** 名前順。リリースがまだないサイト（初回のデプロイ中など）は含めない */
  list(): { name: string; store: Store }[] {
    return [...this.#stores]
      .filter(([, store]) => store.get())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, store]) => ({ name, store }));
  }

  async ensure(name: string): Promise<Store> {
    if (!PROJECT_NAME.test(name)) throw new Error(`サイト名が不正です: ${name}`);
    let store = this.#stores.get(name);
    if (!store) {
      store = new Store(path.join(this.dir, name));
      await store.init();
      this.#stores.set(name, store);
    }
    return store;
  }

  async remove(name: string): Promise<void> {
    const store = this.#stores.get(name);
    if (!store) return;
    this.#stores.delete(name);
    closeSiteDb(store.siteDir);
    await fs.rm(store.siteDir, { recursive: true, force: true });
    if (this.#root === name) await this.setRoot(null);
  }

  /** サイトの URL。ルートドメインで配信しているサイトはルートの URL を主にする（サブドメインは補足） */
  urls(rootOrigin: string, name: string): { url: string; subdomainUrl: string } {
    const subdomainUrl = `${siteOrigin(rootOrigin, name)}/`;
    return { url: this.#root === name ? `${rootOrigin}/` : subdomainUrl, subdomainUrl };
  }

  /** ルートドメイン（サブドメインなし）で配信するサイト */
  get root(): string | null {
    return this.#root;
  }

  async setRoot(name: string | null): Promise<void> {
    if (name !== null && !this.#stores.has(name)) throw new Error(`サイトがありません: ${name}`);
    const file = path.join(this.dir, ROOT_FILE);
    if (name === null) await fs.rm(file, { force: true });
    else await fs.writeFile(file, name);
    this.#root = name;
  }
}

const hostname = (host: string) => host.toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");

/**
 * root: ルートドメイン（ルートのサイトを配信し、管理画面も開く）
 * site: サイトのサブドメイン
 * other: ルートドメインが決まっているときの、それ以外のホスト（管理画面と API だけ開く。サイトは配信しない）
 */
export type HostMatch = { kind: "root" } | { kind: "site"; name: string } | { kind: "other" };

/**
 * Host からサイトを決める。
 * - `rootHost`（KANZUME_ORIGIN か管理画面で設定したドメイン）があれば、そのサブドメインだけをサイトとみなす
 * - なければ、先頭のラベルが既存のサイト名で、残りがドメインに見える（ドットを含むか localhost）ときだけサイトとみなす
 */
export function matchHost(host: string, has: (name: string) => boolean, rootHost?: string): HostMatch {
  const h = hostname(host);
  // IP アドレス（192.0.2.1 や [::1]）はサブドメインを持たないので、先頭の数字をサイト名として扱わない
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.startsWith("[")) return { kind: "root" };
  if (rootHost) {
    const root = hostname(rootHost);
    if (h === root) return { kind: "root" };
    if (h.endsWith(`.${root}`)) {
      const label = h.slice(0, -root.length - 1);
      if (!label.includes(".") && has(label)) return { kind: "site", name: label };
    }
    // fa.example.com や xxx.onrender.com など。管理画面はここでも開けるが、サイトは配信しない
    return { kind: "other" };
  }
  const dot = h.indexOf(".");
  if (dot === -1) return { kind: "root" };
  const label = h.slice(0, dot);
  const rest = h.slice(dot + 1);
  if ((rest.includes(".") || rest === "localhost") && has(label)) return { kind: "site", name: label };
  return { kind: "root" };
}

/** サブドメインを外したホスト（ポートは残す）。`blog.example.com:8080` → `example.com:8080` */
export function parentHost(host: string): string {
  const dot = host.indexOf(".");
  return dot === -1 ? host : host.slice(dot + 1);
}
