import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { closeSiteDb } from "./bindings/db.ts";
import { siteOrigin } from "./http.ts";
import { SerialQueue } from "./serial.ts";
import { PROJECT_NAME, Store } from "./store.ts";
import { UserFacingError } from "./errors.ts";
import { MEMBER_DEPLOYED_FILE, ROOT_FILE, siteSettingsFile, sitesDir } from "./layout.ts";
import { normalizeSiteManagedFiles, type SiteManagedFiles } from "./managed-files.ts";
import { newSiteAccessSecret, parseSiteAccess, type SiteAccess } from "./site-auth.ts";

const MAX_VALUE = 5 * 1024;
const MAX_TOTAL = 64 * 1024;
export const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 管理画面で決めるサイトの設定。サイトの ID（ディレクトリ名）は変えず、サブドメインだけを変えられる */
export interface SiteSettings {
  /** 未設定ならサイトの ID と同じ */
  subdomain?: string;
  vars: Record<string, string>;
  /** 値は管理画面に返さない */
  secrets: Record<string, string>;
  /** Kanzume が代わりに返すファイル（robots.txt・security.txt）の、このサイトでの上書き。なければ全体の既定に従う */
  managedFiles?: SiteManagedFiles;
  /** ログインを必須にしているときの、登録したパスキー。なければ誰でも見られる */
  access?: SiteAccess;
}

export interface SettingsPatch {
  subdomain?: string | null;
  vars?: Record<string, string>;
  /** null は削除。書いていないキーはそのまま */
  secrets?: Record<string, string | null>;
  /** Kanzume が代わりに返すファイルの上書き（リクエストの本文のまま。ここで確かめる）。書いていないファイルはそのまま */
  managedFiles?: unknown;
}

export class SettingsError extends UserFacingError {}

/** 入力されたサイトの名前（ID）をそろえる（前後の空白を外し、小文字にする） */
export function normalizeSiteName(input: unknown): string {
  return typeof input === "string" ? input.trim().toLowerCase() : "";
}

/** デプロイ先のサイトがないとき（デプロイは、管理画面で追加したサイトにだけできる） */
export const siteNotFound = (name: string) => new SettingsError(`サイト ${name} がありません。先に管理画面でサイトを追加してください`, 404);

/** 管理画面のハッシュのルート（#/invite・#/repos）と重なる名前。サイトの名前・サブドメインに使わせない */
export const RESERVED_SITE_NAMES: readonly string[] = ["invite", "repos"];

const emptySettings = (): SiteSettings => ({ vars: {}, secrets: {} });

/**
 * Worker を読み込むときに使うので同期で読む（小さいファイル）。
 * ファイルがあるのに読めない・JSON として壊れているときは、ログインを必須にしたまま誰も入れない状態にする
 * （設定なしとして扱うと、ログインを必須にしていたサイトが誰でも見られるようになる）
 */
export function readSiteSettings(siteDir: string): SiteSettings {
  const file = siteSettingsFile(siteDir);
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("JSON のオブジェクトではありません");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptySettings();
    console.error(`[kanzume] ${file} を読めないので、管理画面でパスキーを登録し直すまで誰もサイトを開けません:`, err);
    return { ...emptySettings(), access: { secret: newSiteAccessSecret(), passkeys: [] } };
  }
  return {
    subdomain: typeof raw.subdomain === "string" ? raw.subdomain : undefined,
    vars: { ...(raw.vars as Record<string, string>) },
    secrets: { ...(raw.secrets as Record<string, string>) },
    // 手で書き換えられて壊れていたら、上書きなし（全体の既定に従う）として扱う
    managedFiles: raw.managedFiles ? safeSiteManagedFiles(raw.managedFiles) : undefined,
    access: parseSiteAccess(raw.access),
  };
}

function safeSiteManagedFiles(raw: unknown): SiteManagedFiles | undefined {
  try {
    const files = normalizeSiteManagedFiles(raw);
    return Object.keys(files).length ? files : undefined;
  } catch {
    return undefined;
  }
}

function checkEnv(kind: string, entries: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  let total = 0;
  for (const [key, value] of Object.entries(entries)) {
    if (!ENV_KEY.test(key)) throw new SettingsError(`${kind}の名前「${key}」は英数字と _ で、数字以外から始めてください`);
    const v = String(value ?? "");
    if (v.length > MAX_VALUE) throw new SettingsError(`${kind}「${key}」の値は ${MAX_VALUE / 1024}KB までです`);
    total += key.length + v.length;
    out[key] = v;
  }
  if (total > MAX_TOTAL) throw new SettingsError(`${kind}は合計 ${MAX_TOTAL / 1024}KB までです`);
  return out;
}

/**
 * サイトはサブドメインで分ける（`blog.example.com` → `blog`）。データは `<dataDir>/sites/<name>/` に置くので、
 * KV / R2 はサイトごとに別の sqlite とディレクトリになる。
 */
export class Sites {
  readonly dir: string;
  #stores = new Map<string, Store>();
  #settings = new Map<string, SiteSettings>();
  #queue = new SerialQueue();
  #root: string | null = null;
  /** 管理者以外がデプロイしたことのあるサイト */
  #memberDeployed = new Set<string>();
  /** 新しいサイトのディレクトリを作ったあとに呼ぶ（Worker を子プロセスで動かすとき、権限をそろえる） */
  onCreate: ((name: string, siteDir: string) => void) | null = null;
  /** 設定・ルート・サイトの削除のあとに呼ぶ（バックアップのきっかけ） */
  onChange: (() => void) | null = null;
  /**
   * サイトの名前・サブドメインに使えないラベル。管理画面を開くホスト（fa.example.com の fa）をサイトに取られると、
   * そのホストの管理画面に入れなくなる（パスキーはホストに紐づく）ため。server.ts が管理画面の状態から決める
   */
  reservedLabels: () => Iterable<string> = () => RESERVED_SITE_NAMES;

  /** サイトの名前・サブドメインに使えないラベルか */
  isReserved(label: string): boolean {
    for (const reserved of this.reservedLabels()) if (reserved === label) return true;
    return false;
  }

  constructor(dataDir: string) {
    this.dir = sitesDir(dataDir);
  }

  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    for (const entry of await fs.readdir(this.dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !PROJECT_NAME.test(entry.name)) continue;
      const store = new Store(path.join(this.dir, entry.name));
      await store.init();
      this.#stores.set(entry.name, store);
      this.#settings.set(entry.name, readSiteSettings(store.siteDir));
      if (existsSync(path.join(store.siteDir, MEMBER_DEPLOYED_FILE))) this.#memberDeployed.add(entry.name);
    }
    // 変更のときと同じく、サブドメインの形と重なりを確かめる（ファイルを直接書き換えられても、ほかのサイトのサブドメインを取らせない）。
    // サイトの ID と同じサブドメイン（既定）を先に確保し、それと重なる別名や不正な別名は無視する
    for (const [id, settings] of this.#settings) {
      if (settings.subdomain !== undefined && (!PROJECT_NAME.test(settings.subdomain) || this.isReserved(settings.subdomain))) {
        console.warn(`[kanzume] サイト ${id} のサブドメイン（${settings.subdomain}）は使えないので、${id} で配信します`);
        this.#settings.set(id, { ...settings, subdomain: undefined });
      }
    }
    // 重なりがなくなるまで繰り返す（別名を外したサイトが自分の ID に戻ると、その ID を別名にしていたほかのサイトと重なりうるため）。
    // 並び順に左右されないよう、ID の順に見る
    for (let changed = true; changed; ) {
      changed = false;
      const taken = new Set<string>();
      for (const [id, settings] of this.#settings) if (settings.subdomain === undefined || settings.subdomain === id) taken.add(id);
      for (const id of [...this.#settings.keys()].sort()) {
        const settings = this.#settings.get(id)!;
        const label = settings.subdomain;
        if (label === undefined || label === id) continue;
        if (taken.has(label)) {
          console.warn(`[kanzume] サイト ${id} のサブドメイン（${label}）はほかのサイトと重なるので、${id} で配信します`);
          this.#settings.set(id, { ...settings, subdomain: undefined });
          changed = true;
          continue;
        }
        taken.add(label);
      }
    }
    // 以前は最初のデプロイで自動でルートにしていた。そのときに決まったルートは、そのまま使う
    const raw = await fs.readFile(path.join(this.dir, ROOT_FILE), "utf8").catch(() => null);
    const root = (raw ?? "").trim();
    this.#root = root && this.#stores.has(root) ? root : null;
  }

  has(name: string): boolean {
    return this.#stores.has(name);
  }

  get(name: string): Store | undefined {
    return this.#stores.get(name);
  }

  /** リリースがある（何かデプロイされている）か */
  deployed(name: string): boolean {
    return !!this.#stores.get(name)?.get();
  }

  /** 名前順。まだデプロイしていない（作っただけの）サイトも含める */
  list(): { name: string; store: Store }[] {
    return [...this.#stores].sort(([a], [b]) => a.localeCompare(b)).map(([name, store]) => ({ name, store }));
  }

  async ensure(name: string): Promise<Store> {
    if (!PROJECT_NAME.test(name)) throw new Error(`サイト名が不正です: ${name}`);
    let store = this.#stores.get(name);
    if (!store) {
      if (this.isReserved(name)) throw new SettingsError(`${name} は管理画面で使っている名前なので、サイト名にできません`);
      // 新しいサイトのサブドメインは ID と同じ。ほかのサイトがそのサブドメインを使っていたら作らない
      const owner = this.resolve(name);
      if (owner && owner !== name) throw new SettingsError(`サブドメイン ${name} はサイト ${owner} が使っています。別の名前にしてください`);
      store = new Store(path.join(this.dir, name));
      await store.init();
      // 作った時点で所有者とモードを決める（このあと本体が作る KV / R2・リリースも、Worker の子プロセスから使えるように）
      this.onCreate?.(name, store.siteDir);
      this.#stores.set(name, store);
      this.#settings.set(name, readSiteSettings(store.siteDir));
    }
    return store;
  }

  settings(id: string): SiteSettings {
    return this.#settings.get(id) ?? emptySettings();
  }

  subdomain(id: string): string {
    return this.#settings.get(id)?.subdomain ?? id;
  }

  /** サブドメインからサイトの ID を引く */
  resolve(label: string): string | undefined {
    for (const id of this.#stores.keys()) if (this.subdomain(id) === label) return id;
    return undefined;
  }

  /** 同じサイトの設定の書き込みは 1 つずつ（同じ一時ファイルを使うのと、読んでから書くまでの間に別の変更を挟まないため） */
  updateSettings(id: string, patch: SettingsPatch): Promise<SiteSettings> {
    return this.#queue.run(id, () => this.#updateSettings(id, patch));
  }

  /**
   * 環境変数とシークレットを前の状態に戻す（デプロイと一緒に変えて、デプロイに失敗したとき）。
   * サブドメインなどほかの設定は戻さない（戻すと、その間にほかのサイトが取ったサブドメインと重なったり、登録・削除したパスキーが元に戻ったりする）
   */
  restoreSettings(id: string, settings: Pick<SiteSettings, "vars" | "secrets">): Promise<SiteSettings> {
    return this.#queue.run(id, async () => {
      const store = this.#stores.get(id);
      if (!store) throw new SettingsError("サイトが見つかりません");
      return this.#write(id, store.siteDir, { ...this.settings(id), vars: { ...settings.vars }, secrets: { ...settings.secrets } });
    });
  }

  /** ログインのパスキーを変える。update が undefined を返したらログインをやめる */
  updateAccess(id: string, update: (current: SiteAccess | undefined) => SiteAccess | undefined): Promise<SiteSettings> {
    return this.#queue.run(id, async () => {
      const store = this.#stores.get(id);
      if (!store) throw new SettingsError("サイトが見つかりません");
      const next: SiteSettings = { ...this.settings(id) };
      const access = update(next.access);
      if (access) next.access = access;
      else delete next.access;
      return this.#write(id, store.siteDir, next);
    });
  }

  async #updateSettings(id: string, patch: SettingsPatch): Promise<SiteSettings> {
    const store = this.#stores.get(id);
    if (!store) throw new SettingsError("サイトが見つかりません");
    const current = this.settings(id);
    const next: SiteSettings = { ...current, vars: { ...current.vars }, secrets: { ...current.secrets } };
    if (patch.subdomain !== undefined) {
      const sub = patch.subdomain === null || patch.subdomain === "" ? id : patch.subdomain.trim().toLowerCase();
      if (!PROJECT_NAME.test(sub)) throw new SettingsError("サブドメインは英小文字・数字・ハイフンで 63 文字以内にしてください");
      if (sub !== this.subdomain(id) && this.isReserved(sub)) throw new SettingsError(`${sub} は管理画面で使っている名前なので、サブドメインにできません`);
      const owner = this.resolve(sub);
      if (owner && owner !== id) throw new SettingsError(`サブドメイン ${sub} はサイト ${owner} が使っています`);
      if (sub === id) delete next.subdomain;
      else next.subdomain = sub;
    }
    if (patch.managedFiles !== undefined) {
      const files = normalizeSiteManagedFiles(patch.managedFiles, current.managedFiles);
      if (Object.keys(files).length) next.managedFiles = files;
      else delete next.managedFiles;
    }
    if (patch.vars !== undefined) next.vars = checkEnv("環境変数", patch.vars);
    if (patch.secrets !== undefined) {
      for (const [key, value] of Object.entries(patch.secrets)) {
        if (value === null) delete next.secrets[key];
        else next.secrets[key] = value;
      }
      next.secrets = checkEnv("シークレット", next.secrets);
    }
    return this.#write(id, store.siteDir, next);
  }

  async #write(id: string, siteDir: string, next: SiteSettings): Promise<SiteSettings> {
    // 書いている間にサイトが消されたら、ディレクトリを作り直さない
    if (this.#stores.get(id)?.siteDir !== siteDir) throw new SettingsError("サイトが見つかりません");
    const file = siteSettingsFile(siteDir);
    await fs.writeFile(`${file}.tmp`, JSON.stringify(next, null, 2), { mode: 0o600 });
    await fs.rename(`${file}.tmp`, file);
    this.#settings.set(id, next);
    this.onChange?.();
    return next;
  }

  async remove(name: string): Promise<void> {
    const store = this.#stores.get(name);
    if (!store) return;
    this.#stores.delete(name);
    this.#settings.delete(name);
    this.#memberDeployed.delete(name);
    closeSiteDb(store.siteDir);
    await fs.rm(store.siteDir, { recursive: true, force: true });
    if (this.#root === name) await this.setRoot(null);
    this.onChange?.();
  }

  /** サイトの URL。ルートドメインで配信しているサイトはルートの URL を主にする（サブドメインは補足） */
  urls(rootOrigin: string, name: string): { url: string; subdomainUrl: string } {
    const subdomainUrl = `${siteOrigin(rootOrigin, this.subdomain(name))}/`;
    return { url: this.#root === name ? `${rootOrigin}/` : subdomainUrl, subdomainUrl };
  }

  /** ルートドメイン（サブドメインなし）で配信するサイト */
  get root(): string | null {
    return this.#root;
  }

  /**
   * ルートドメインで配信するサイトを変える（管理者が選んだときだけ。デプロイでは変えない）。
   * 書き込みを待つ前に切り替える（呼び出し側の確かめと切り替えの間に、メンバーのデプロイを挟ませないため。
   * デプロイ側も、ルートかを見てから markMemberDeployed するまでを同期で行う）
   */
  async setRoot(name: string | null): Promise<void> {
    if (name !== null && !this.#stores.has(name)) throw new Error(`サイトがありません: ${name}`);
    const prev = this.#root;
    this.#root = name;
    try {
      await fs.writeFile(path.join(this.dir, ROOT_FILE), name ?? "");
    } catch (err) {
      if (this.#root === name) this.#root = prev;
      throw err;
    }
    this.onChange?.();
  }

  /** 管理者以外（メンバーのトークン・セッション・push）がデプロイしたことがあるか。一度でもあれば、ルートドメインにしない */
  memberDeployed(name: string): boolean {
    return this.#memberDeployed.has(name);
  }

  /**
   * 管理者以外のデプロイを記録する（リリースを作る前に呼ぶ）。印は同期で付け、ファイルにはそのあと書く。
   * 履歴（meta.sqlite）に頼らないのは、サイトごとに古いものから消えるため
   */
  async markMemberDeployed(name: string): Promise<void> {
    const store = this.#stores.get(name);
    if (!store || this.#memberDeployed.has(name)) return;
    this.#memberDeployed.add(name);
    await fs.writeFile(path.join(store.siteDir, MEMBER_DEPLOYED_FILE), "");
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
export function matchHost(host: string, resolve: (label: string) => string | undefined, rootHost?: string): HostMatch {
  const h = hostname(host);
  const label = siteLabel(h, rootHost);
  const id = label === undefined ? undefined : resolve(label);
  if (id) return { kind: "site", name: id };
  // ルートドメインが決まっているときの fa.example.com や xxx.up.railway.app など。管理画面はここでも開けるが、サイトは配信しない
  if (rootHost && h !== hostname(rootHost)) return { kind: "other" };
  return { kind: "root" };
}

/**
 * そのホストがサイトのサブドメインとして読まれるときのラベル（matchHost と同じ規則）。サイトとして読まれないホストなら undefined。
 * `blog.example.com` → `blog`（ルートドメインが example.com のとき、または未設定のとき）
 */
export function siteLabel(host: string, rootHost?: string): string | undefined {
  const h = hostname(host);
  // IP アドレス（192.0.2.1 や [::1]）はサブドメインを持たないので、先頭の数字をサイト名として扱わない
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.startsWith("[")) return undefined;
  if (rootHost) {
    const root = hostname(rootHost);
    if (!h.endsWith(`.${root}`)) return undefined;
    const label = h.slice(0, -root.length - 1);
    return label.includes(".") ? undefined : label;
  }
  const dot = h.indexOf(".");
  if (dot === -1) return undefined;
  const rest = h.slice(dot + 1);
  return rest.includes(".") || rest === "localhost" ? h.slice(0, dot) : undefined;
}

/** サブドメインを外したホスト（ポートは残す）。`blog.example.com:8080` → `example.com:8080` */
export function parentHost(host: string): string {
  const dot = host.indexOf(".");
  return dot === -1 ? host : host.slice(dot + 1);
}
