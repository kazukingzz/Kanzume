/**
 * Kanzume が代わりに返すファイル（robots.txt と security.txt）。サイトのデプロイしたファイルになく、設定が有効なときに返す。
 * 設定は、全体の既定（管理者設定）と、サイトごとの上書き（サイト設定）で持つ。
 *
 * Cloudflare の「Managed robots.txt（Bot Preference Sync）」と「Security.txt」にならっている:
 * - robots.txt: 検索・AI エージェント・AI の学習のそれぞれを許可するか断るかを選び、Content-Signal と
 *   AI 学習用クローラーへの Disallow を出す（指示であって、強制ではない）
 * - security.txt: 連絡先・期限などをフォームに入れ、/.well-known/security.txt（RFC 9116）を出す
 */
import { UserFacingError } from "./errors.ts";

export type Policy = "allow" | "block";

export interface RobotsConfig {
  enabled: boolean;
  /** 検索（検索結果へのリンクと抜粋）。Content-Signal の search */
  search: Policy;
  /** AI エージェント（AI の回答に、その場で内容を使う）。Content-Signal の ai-input */
  agent: Policy;
  /** AI の学習。Content-Signal の ai-train と、学習用クローラーへの Disallow */
  training: Policy;
  /** 追加のルール（Sitemap: や Disallow: など。そのまま末尾に足す） */
  extra: string;
}

export interface SecurityTxtConfig {
  enabled: boolean;
  /** mailto:・tel:・https:// のどれかで始まる連絡先（1 つ以上） */
  contact: string[];
  /** この日時を過ぎたら古い情報として扱われる（ISO 8601） */
  expires: string;
  encryption: string;
  acknowledgements: string;
  canonical: string;
  hiring: string;
  policy: string;
  /** 対応できる言語（例: ja, en） */
  preferredLanguages: string;
}

/** 全体の既定（管理者設定） */
export interface ManagedFiles {
  robots?: RobotsConfig;
  securityTxt?: SecurityTxtConfig;
}

/** default: 全体の既定に従う、custom: このサイトだけの設定（config）、off: このサイトでは返さない */
export type OverrideMode = "default" | "custom" | "off";

export interface Override<T> {
  mode: OverrideMode;
  config?: T;
}

/** サイトごとの上書き（サイト設定）。書いていないファイルは「全体の既定に従う」 */
export interface SiteManagedFiles {
  robots?: Override<RobotsConfig>;
  securityTxt?: Override<SecurityTxtConfig>;
}

export type ManagedKind = keyof ManagedFiles;

/** Kanzume が返すパス */
export const MANAGED_PATHS: Readonly<Record<string, ManagedKind>> = {
  "/robots.txt": "robots",
  "/.well-known/security.txt": "securityTxt",
};

export const MANAGED_FILE_PATH: Record<ManagedKind, string> = { robots: "/robots.txt", securityTxt: "/.well-known/security.txt" };

/** 学習用のクローラー（Cloudflare の Managed robots.txt が Disallow にするものと同じ） */
export const TRAINING_CRAWLERS = ["Amazonbot", "Applebot-Extended", "Bytespider", "CCBot", "ClaudeBot", "Google-Extended", "GPTBot", "meta-externalagent"];

const MAX_EXTRA = 8 * 1024;
const MAX_FIELD = 2048;
const MAX_CONTACTS = 10;

export const defaultRobots = (): RobotsConfig => ({ enabled: false, search: "allow", agent: "allow", training: "block", extra: "" });

export const defaultSecurityTxt = (): SecurityTxtConfig => ({
  enabled: false,
  contact: [],
  expires: "",
  encryption: "",
  acknowledgements: "",
  canonical: "",
  hiring: "",
  policy: "",
  preferredLanguages: "",
});

const bad = (message: string): never => {
  throw new UserFacingError(message, 400);
};

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

const policy = (v: unknown, fallback: Policy): Policy => (v === "allow" || v === "block" ? v : fallback);

/** 1 行の値（改行や制御文字が入っていたら断る。ほかの行を差し込ませない） */
function line(label: string, v: unknown): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (s.length > MAX_FIELD) return bad(`${label} が長すぎます`);
  if (/[\u0000-\u001f\u007f]/.test(s)) return bad(`${label} に改行や制御文字は使えません`);
  return s;
}

/** https:// の URL（空なら空のまま） */
function httpsUrl(label: string, v: unknown): string {
  const s = line(label, v);
  if (!s) return "";
  if (!/^https:\/\//i.test(s) || !URL.canParse(s)) return bad(`${label} は https:// で始まる URL にしてください`);
  return s;
}

export function normalizeRobots(input: unknown): RobotsConfig {
  if (!isRecord(input)) return bad("robots.txt の設定を読めません");
  const d = defaultRobots();
  const extra = typeof input.extra === "string" ? input.extra.replace(/\r\n?/g, "\n").trim() : "";
  if (Buffer.byteLength(extra) > MAX_EXTRA) return bad(`追加のルールは ${MAX_EXTRA / 1024} KiB までです`);
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(extra)) return bad("追加のルールに制御文字は使えません");
  return {
    enabled: input.enabled === true,
    search: policy(input.search, d.search),
    agent: policy(input.agent, d.agent),
    training: policy(input.training, d.training),
    extra,
  };
}

export function normalizeSecurityTxt(input: unknown): SecurityTxtConfig {
  if (!isRecord(input)) return bad("security.txt の設定を読めません");
  const rawContacts = Array.isArray(input.contact) ? input.contact : [];
  const contact = rawContacts.map((c) => line("Contact", c)).filter(Boolean);
  if (contact.length > MAX_CONTACTS) return bad(`Contact は ${MAX_CONTACTS} 件までです`);
  for (const c of contact) {
    const ok = /^mailto:[^\s@]+@[^\s@]+$/i.test(c) || /^tel:\+?[0-9().\- ]+$/i.test(c) || (/^https:\/\//i.test(c) && URL.canParse(c));
    if (!ok) return bad(`Contact は mailto:（メール）・tel:（電話）・https://（URL）のどれかで始めてください: ${c}`);
  }
  const enabled = input.enabled === true;
  let expires = "";
  const rawExpires = line("期限", input.expires);
  if (rawExpires) {
    const at = new Date(rawExpires);
    if (Number.isNaN(at.getTime())) return bad("期限の日時を読めません");
    expires = at.toISOString();
  }
  // 有効にするには、RFC 9116 で必須の Contact と Expires が要る
  if (enabled && contact.length === 0) return bad("security.txt を有効にするには、Contact を 1 つ以上入力してください");
  if (enabled && !expires) return bad("security.txt を有効にするには、期限を入力してください");
  const languages = line("Preferred languages", input.preferredLanguages);
  if (languages && !/^[A-Za-z]{2,3}(-[A-Za-z0-9]+)*(\s*,\s*[A-Za-z]{2,3}(-[A-Za-z0-9]+)*)*$/.test(languages)) {
    return bad("Preferred languages は ja, en のように言語コードをカンマで区切ってください");
  }
  return {
    enabled,
    contact,
    expires,
    encryption: httpsUrl("Encryption", input.encryption),
    acknowledgements: httpsUrl("Acknowledgements", input.acknowledgements),
    canonical: httpsUrl("Canonical", input.canonical),
    hiring: httpsUrl("Hiring", input.hiring),
    policy: httpsUrl("Policy", input.policy),
    preferredLanguages: languages,
  };
}

/** 全体の既定（null・未指定のファイルは変えない） */
export function normalizeManagedFiles(input: unknown, current: ManagedFiles = {}): ManagedFiles {
  if (!isRecord(input)) return bad("設定を読めません");
  const next: ManagedFiles = { ...current };
  if (input.robots !== undefined) next.robots = normalizeRobots(input.robots);
  if (input.securityTxt === null) delete next.securityTxt;
  else if (input.securityTxt !== undefined) next.securityTxt = normalizeSecurityTxt(input.securityTxt);
  return next;
}

function normalizeOverride<T>(label: string, input: unknown, normalize: (v: unknown) => T): Override<T> | undefined {
  if (!isRecord(input)) return bad(`${label} の設定を読めません`);
  if (input.mode === "off") return { mode: "off" };
  if (input.mode === "custom") return { mode: "custom", config: normalize(input.config) };
  if (input.mode === "default") return undefined;
  return bad(`${label} の mode は default・custom・off のどれかにしてください`);
}

/** サイトごとの上書き（未指定のファイルは変えない。「既定に従う」は書かずに消す） */
export function normalizeSiteManagedFiles(input: unknown, current: SiteManagedFiles = {}): SiteManagedFiles {
  if (!isRecord(input)) return bad("設定を読めません");
  const next: SiteManagedFiles = { ...current };
  if (input.robots !== undefined) {
    const o = normalizeOverride("robots.txt", input.robots, normalizeRobots);
    if (o) next.robots = o;
    else delete next.robots;
  }
  if (input.securityTxt !== undefined) {
    const o = normalizeOverride("security.txt", input.securityTxt, normalizeSecurityTxt);
    if (o) next.securityTxt = o;
    else delete next.securityTxt;
  }
  return next;
}

const signal = (p: Policy) => (p === "allow" ? "yes" : "no");

export function renderRobots(c: RobotsConfig): string {
  const lines = [
    "# Content-Signal は、このサイトの内容を取得したあとの使い方についての希望です。",
    "#   search:   検索の索引を作り、検索結果にリンクや短い抜粋を出す",
    "#   ai-input: AI の回答を作るときに、その場で内容を入力として使う",
    "#   ai-train: AI モデルの学習や調整に使う",
    "# yes は許可、no は許可しないことを表します。 https://contentsignals.org/",
    "",
    "User-agent: *",
    `Content-Signal: search=${signal(c.search)}, ai-input=${signal(c.agent)}, ai-train=${signal(c.training)}`,
    "Allow: /",
  ];
  if (c.training === "block") {
    lines.push("", "# AI の学習用のクローラー");
    for (const bot of TRAINING_CRAWLERS) lines.push("", `User-agent: ${bot}`, "Disallow: /");
  }
  if (c.extra) lines.push("", c.extra);
  return `${lines.join("\n")}\n`;
}

export function renderSecurityTxt(c: SecurityTxtConfig): string {
  const lines = c.contact.map((v) => `Contact: ${v}`);
  if (c.expires) lines.push(`Expires: ${c.expires}`);
  const optional: [string, string][] = [
    ["Encryption", c.encryption],
    ["Acknowledgments", c.acknowledgements],
    ["Preferred-Languages", c.preferredLanguages],
    ["Canonical", c.canonical],
    ["Policy", c.policy],
    ["Hiring", c.hiring],
  ];
  for (const [name, value] of optional) if (value) lines.push(`${name}: ${value}`);
  return `${lines.join("\n")}\n`;
}

/** サイトの上書きと全体の既定から、そのサイトに使う設定を決める（返さないなら null） */
export function effectiveConfig<K extends ManagedKind>(kind: K, global: ManagedFiles, site: SiteManagedFiles | undefined): NonNullable<ManagedFiles[K]> | null {
  const override = site?.[kind] as Override<NonNullable<ManagedFiles[K]>> | undefined;
  if (override?.mode === "off") return null;
  const config = override?.mode === "custom" ? override.config : global[kind];
  return config?.enabled ? (config as NonNullable<ManagedFiles[K]>) : null;
}

// 設定を変えると設定のオブジェクトが入れ替わるので、オブジェクトごとに作った中身を覚えておけば、変えたときだけ作り直される
const rendered = new WeakMap<object, string>();

/** そのサイトに返す中身（返さないなら null） */
export function resolveManagedFile(kind: ManagedKind, global: ManagedFiles, site: SiteManagedFiles | undefined): string | null {
  const config = effectiveConfig(kind, global, site);
  if (!config) return null;
  let text = rendered.get(config);
  if (text === undefined) {
    text = kind === "robots" ? renderRobots(config as RobotsConfig) : renderSecurityTxt(config as SecurityTxtConfig);
    rendered.set(config, text);
  }
  return text;
}

/** 入力（保存前でもよい）から中身を作る。管理画面のプレビュー用 */
export function previewManagedFile(kind: ManagedKind, input: unknown): string {
  return kind === "robots" ? renderRobots(normalizeRobots(input)) : renderSecurityTxt(normalizeSecurityTxt(input));
}
