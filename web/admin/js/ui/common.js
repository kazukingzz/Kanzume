import { api } from "../core/api.js";
import { h, safeUrl } from "../core/dom.js";
import { currentSiteUrl, SITE_TABS, siteApi, state } from "../core/state.js";

export function pageHead(title, extra = []) {
  return h(
    "div",
    { class: "page-head" },
    h("h1", { text: title }),
    ...extra,
    h("span", { class: "spacer" }),
    SITE_TABS[state.tab] && currentSiteUrl()
      ? h("a", { class: "open", href: currentSiteUrl(), target: "_blank", rel: "noopener", text: "サイトを開く ↗" })
      : null,
  );
}

export function statusBadge(status) {
  return status === "success" ? h("span", { class: "status good", text: "成功" }) : h("span", { class: "status bad", text: "失敗" });
}

export function commitLink(source) {
  if (!source?.sha) return null;
  const short = source.sha.slice(0, 7);
  if (source.repository && safeUrl(source.serverUrl)) {
    return h("a", { href: `${source.serverUrl}/${source.repository}/commit/${source.sha}`, target: "_blank", rel: "noopener", class: "mono", text: short });
  }
  return h("span", { class: "mono", text: short });
}

// ---------- デプロイ ----------

export function siteUrlCell(detail) {
  const link = (url) => h("a", { href: url, target: "_blank", rel: "noopener", text: url });
  if (detail.url === detail.subdomainUrl) return link(detail.url);
  return h("div", { class: "urls" }, link(detail.url), h("span", { class: "muted" }, "サブドメイン: ", link(detail.subdomainUrl)));
}

export async function loadSite() {
  const name = state.siteName;
  const detail = await api(siteApi());
  // 読み込んでいる間にほかのサイトへ移っていたら、そのサイトの情報を上書きしない
  if (state.siteName === name) state.site = detail;
  return detail;
}

// ---------- 動的 / 静的 ----------

export const KIND = {
  dynamic: {
    label: "動的",
    title: "動的サイト（Worker）",
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/></svg>',
    text: "リクエストごとにサーバーで Worker（JavaScript）を実行します。アクセスがあるとこのサイト専用のプロセスが起動し、メモリと CPU を使います。",
  },
  static: {
    label: "静的",
    title: "静的サイト",
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/></svg>',
    text: "HTML・画像などのファイルをそのまま配信します。Worker を実行しないので、プロセスやメモリをほとんど使いません。",
  },
};

export const releaseKind = (release) => (release ? (release.main ? "dynamic" : "static") : null);

/** 小さいバッジ（サイトの切り替え・一覧用） */
export function kindBadge(kind) {
  if (!kind) return null;
  return h("span", { class: `kind-badge ${kind}`, text: KIND[kind].label, title: KIND[kind].title });
}

/** 大きめの表示（デプロイ・サイト設定の上） */
export function kindBanner(kind) {
  const k = KIND[kind];
  return h(
    "section",
    { class: `kind-banner ${kind}` },
    h("span", { class: "kind-icon", html: k.icon }),
    h(
      "div",
      { class: "kind-body" },
      h("div", { class: "kind-eyebrow", text: "サイトの種類" }),
      h("div", { class: "kind-title", text: k.title }),
      h("p", { text: k.text }),
    ),
  );
}

export function bindingTags(release) {
  return [
    release.main ? h("span", { class: "tag", text: "Worker" }) : null,
    release.assets ? h("span", { class: "tag", text: "Assets" }) : null,
    ...release.kv.map((b) => h("span", { class: "tag", text: `KV: ${b}` })),
    ...release.r2.map((b) => h("span", { class: "tag", text: `R2: ${b.binding}` })),
  ].filter(Boolean);
}

export function busy(button, label) {
  button.disabled = true;
  button.textContent = label;
}

export function tableView(headers, rows) {
  return h(
    "details",
    { class: "table-view" },
    h("summary", { text: "表で見る" }),
    h(
      "div",
      { class: "scroll" },
      h(
        "table",
        {},
        h("thead", {}, h("tr", {}, ...headers.map((x, i) => h("th", { class: i ? "num" : "", text: x })))),
        h(
          "tbody",
          {},
          ...rows
            .filter((r) => r.slice(1).some((v) => v && v !== "–"))
            .map((r) => h("tr", {}, ...r.map((v, i) => h("td", { class: i ? "num" : "", text: v })))),
        ),
      ),
    ),
  );
}

export function copyButton(get) {
  const b = h("button", { text: "コピー" });
  b.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(get());
      b.textContent = "コピーしました";
    } catch {
      b.textContent = "コピーできません";
    }
    setTimeout(() => (b.textContent = "コピー"), 1500);
  });
  return b;
}

export function armed(button, label, confirmLabel, action) {
  let ready = false;
  let timer = null;
  button.textContent = label;
  button.addEventListener("click", async () => {
    if (!ready) {
      ready = true;
      button.classList.add("confirm");
      button.textContent = confirmLabel;
      timer = setTimeout(() => {
        ready = false;
        button.classList.remove("confirm");
        button.textContent = label;
      }, 4000);
      return;
    }
    clearTimeout(timer);
    ready = false;
    button.classList.remove("confirm");
    button.textContent = label;
    await action();
  });
  return button;
}

// ---------- データベース（KV）・ストレージ（R2） ----------

export const ICONS = {
  database:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></svg>',
  storage: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7l9-4 9 4-9 4-9-4z"/><path d="M3 12l9 4 9-4M3 17l9 4 9-4"/></svg>',
  folder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  file: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></svg>',
};

export const icon = (name, cls = "icon") => h("span", { class: cls, html: ICONS[name] });

/** 何もないときの表示。wrangler の設定の例を添える */
export function emptyState(iconName, title, text, snippet) {
  return h(
    "section",
    { class: "card empty-state" },
    icon(iconName, "empty-icon"),
    h("h2", { text: title }),
    h("p", { class: "muted", text }),
    snippet ? h("pre", { class: "log", text: snippet }) : null,
  );
}

/** 複数あるときだけ出す切り替え（KV の名前空間・R2 のバケット） */
export function chooser(items, current, onChange, label) {
  if (items.length <= 1) return null;
  const select = h("select", { "aria-label": label }, ...items.map((x) => h("option", { value: x.name, text: x.label ?? x.name })));
  select.value = current;
  select.addEventListener("change", () => onChange(select.value));
  return h("label", { class: "inline" }, label, select);
}

// ---------- リポジトリ ----------

export const TTL_OPTIONS = [
  ["3600", "1 時間"],
  ["86400", "1 日"],
  ["2592000", "30 日"],
  ["", "無期限"],
];
