export const BASE = "/_admin/kanzume";

// サイトごとのタブ（#/<サイト>/<タブ>）と、全体のタブ（#/<タブ>）
export const SITE_TABS = {
  deployments: "デプロイ",
  code: "コード",
  observability: "可観測性",
  database: "データベース",
  storage: "ストレージ",
  repo: "リポジトリ",
  site: "サイト設定",
};

export const GLOBAL_TABS = { new: "サイトを追加", resources: "リソース", settings: "設定", admin: "管理者設定" };

// まだデプロイしていないサイトでは出さないタブ
export const DEPLOYED_TABS = new Set(["code", "observability"]);

// 管理者だけのタブ（メンバーには出さない）
export const ADMIN_TABS = new Set(["new", "resources", "admin"]);

export const isAdmin = () => state.overview?.me?.role === "admin";

export const NEW_SITE = "__new";

export const state = {
  overview: null,
  sites: { root: null, sites: [], pending: [] },
  siteName: null,
  site: null,
  tab: "deployments",
  timers: [],
  /** 表示の世代。画面を移るたびに増やし、移る前に始めた表示の読み込みが終わっても描かないようにする */
  gen: 0,
  obs: { view: "overview", range: "24h", result: "", kind: "", q: "", live: false },
  code: { group: null, path: null },
  // リポジトリごとに、最後に見ていたブランチ
  repoRefs: {},
};

/** 表示しているサイトの URL（サイトの一覧から。ほかのサイトの詳細を読み込み中でも食い違わない） */
export const currentSiteUrl = () => state.sites.sites.find((x) => x.name === state.siteName)?.url ?? null;

export function clearTimers() {
  for (const t of state.timers) clearInterval(t);
  state.timers = [];
}

export const hostOf = (url) => url.replace(/^https?:\/\//, "").replace(/\/$/, "");

export const siteApi = (path = "") => `/sites/${encodeURIComponent(state.siteName)}${path}`;
