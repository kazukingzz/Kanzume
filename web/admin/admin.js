const BASE = "/_admin/kanzume";
const $ = (id) => document.getElementById(id);
// サイトごとのタブ（#/<サイト>/<タブ>）と、全体のタブ（#/<タブ>）
const SITE_TABS = { deployments: "デプロイ", code: "コード", observability: "可観測性", database: "データベース", storage: "ストレージ", repo: "リポジトリ", site: "サイト設定" };
const GLOBAL_TABS = { new: "サイトを追加", resources: "リソース", settings: "設定", admin: "管理者設定" };
// まだデプロイしていないサイトでは出さないタブ
const DEPLOYED_TABS = new Set(["code", "observability"]);
// 管理者だけのタブ（メンバーには出さない）
const ADMIN_TABS = new Set(["new", "resources", "admin"]);
const isAdmin = () => state.overview?.me?.role === "admin";
const NEW_SITE = "__new";

const state = {
  overview: null,
  sites: { root: null, sites: [], pending: [] },
  siteName: null,
  site: null,
  tab: "deployments",
  timers: [],
  obs: { view: "overview", range: "24h", result: "", kind: "", q: "", live: false },
  code: { group: null, path: null },
  // リポジトリごとに、最後に見ていたブランチ
  repoRefs: {},
};

// ---------- utilities ----------

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k === "html") el.innerHTML = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

function fill(el, ...children) {
  el.replaceChildren(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
}

async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(`${BASE}/api${path}`, {
      ...options,
      headers: { "content-type": "application/json", ...(options.headers || {}) },
      credentials: "same-origin",
    });
  } catch {
    // 「Failed to fetch」はサーバーから応答がなかったとき（再起動中・ネットワークの切断）に出る
    throw new Error("サーバーに接続できませんでした。サーバーが再起動中かもしれません。しばらく待ってからページを再読み込みしてください。");
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith("/state")) {
    showAuth("login");
    throw new Error("ログインしてください");
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const fmtDate = (v) => new Date(v).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const fmtTime = (v) => new Date(v).toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const fmtShort = (v, withDate) =>
  new Date(v).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", ...(withDate ? { month: "numeric", day: "numeric" } : {}), hour: "2-digit", minute: "2-digit" });

function fmtAgo(v) {
  const s = Math.round((Date.now() - new Date(v).getTime()) / 1000);
  if (s < 60) return `${Math.max(s, 0)} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 時間前`;
  return `${Math.floor(s / 86400)} 日前`;
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

function fmtMs(v) {
  if (v === null || v === undefined) return "–";
  if (v >= 1000) return `${(v / 1000).toFixed(2)} s`;
  if (v >= 100) return `${Math.round(v)} ms`;
  return `${v.toFixed(1)} ms`;
}

function fmtCount(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString("ja-JP");
}

function clearTimers() {
  for (const t of state.timers) clearInterval(t);
  state.timers = [];
}

// ---------- passkey ----------

const b64ToBuf = (s) => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0)).buffer;
};
const bufToB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function creationOptions(json) {
  if (PublicKeyCredential.parseCreationOptionsFromJSON) return PublicKeyCredential.parseCreationOptionsFromJSON(json);
  return {
    ...json,
    challenge: b64ToBuf(json.challenge),
    user: { ...json.user, id: b64ToBuf(json.user.id) },
    excludeCredentials: (json.excludeCredentials || []).map((c) => ({ ...c, id: b64ToBuf(c.id) })),
  };
}

function requestOptions(json) {
  if (PublicKeyCredential.parseRequestOptionsFromJSON) return PublicKeyCredential.parseRequestOptionsFromJSON(json);
  return { ...json, challenge: b64ToBuf(json.challenge), allowCredentials: (json.allowCredentials || []).map((c) => ({ ...c, id: b64ToBuf(c.id) })) };
}

function credentialJSON(cred) {
  if (typeof cred.toJSON === "function") return cred.toJSON();
  const r = cred.response;
  const response = { clientDataJSON: bufToB64(r.clientDataJSON) };
  if (r.attestationObject) {
    response.attestationObject = bufToB64(r.attestationObject);
    response.transports = r.getTransports ? r.getTransports() : [];
  } else {
    response.authenticatorData = bufToB64(r.authenticatorData);
    response.signature = bufToB64(r.signature);
    if (r.userHandle) response.userHandle = bufToB64(r.userHandle);
  }
  return { id: cred.id, rawId: bufToB64(cred.rawId), type: cred.type, response, clientExtensionResults: cred.getClientExtensionResults(), authenticatorAttachment: cred.authenticatorAttachment };
}

function showAuth(view) {
  clearTimers();
  $("app").hidden = true;
  $("auth").hidden = false;
  for (const id of ["auth-loading", "setup", "login", "invite"]) $(id).hidden = id !== view;
  if (view === "login") $("login-error").textContent = "";
}

/** パスキーを登録する。options と verify には同じ body を送る（サーバーは verify でも登録してよいかを確かめ直す） */
async function registerPasskey(body = {}) {
  const options = await api("/register/options", { method: "POST", body: JSON.stringify(body) });
  const cred = await navigator.credentials.create({ publicKey: creationOptions(options) });
  await api("/register/verify", { method: "POST", body: JSON.stringify({ ...body, response: credentialJSON(cred) }) });
}

$("register").addEventListener("click", async () => {
  $("setup-error").textContent = "";
  try {
    await registerPasskey({ setupToken: $("setup-token").value.trim() });
    // ルートドメインはパスキーを登録してから（ログインした状態で）保存する
    let domainError = null;
    if (!$("setup-domain-field").hidden) {
      await api("/domain", { method: "POST", body: JSON.stringify({ domain: $("setup-domain").value.trim() }) }).catch((err) => (domainError = err));
    }
    await enterApp();
    if (domainError) {
      go("#/admin");
      alert(`パスキーは登録しましたが、ドメインを保存できませんでした: ${domainError.message}\n管理者設定のページで設定してください。`);
    }
  } catch (err) {
    $("setup-error").textContent = err.message;
  }
});

// ---------- 招待 ----------

const inviteToken = () => (/^#\/invite\/([^/]+)/.exec(location.hash) || [])[1] ?? null;

async function showInvite(token) {
  showAuth("invite");
  $("invite-error").textContent = "";
  $("invite-form").hidden = true;
  try {
    const info = await api(`/invite?token=${encodeURIComponent(token)}`);
    if (!info.valid) {
      $("invite-desc").textContent = "この招待リンクは使えません（使用済み・期限切れ・取り消し済みのいずれか）。管理者に新しいリンクを頼んでください。";
      return;
    }
    $("invite-desc").textContent = `サイト ${info.site} のメンバーとして参加します。パスキーを登録すると、このサイトのデプロイ・設定・削除ができるようになります（${fmtDate(info.expiresAt).slice(0, 10)} まで有効）。`;
    $("invite-form").hidden = false;
    $("invite-name").focus();
  } catch (err) {
    $("invite-desc").textContent = "";
    $("invite-error").textContent = err.message;
  }
}

$("invite-join").addEventListener("click", async () => {
  $("invite-error").textContent = "";
  const join = { inviteToken: inviteToken(), name: $("invite-name").value.trim() };
  if (!join.name) {
    $("invite-error").textContent = "名前を入力してください";
    $("invite-name").focus();
    return;
  }
  try {
    await registerPasskey(join);
    go("#/");
    await enterApp();
  } catch (err) {
    $("invite-error").textContent = err.message;
  }
});

// 登録済みの人はサインインしてから、招待のページで「参加する」を押す
$("invite-signin").addEventListener("click", (e) => {
  e.preventDefault();
  showAuth("login");
});

async function viewInvite(main, token) {
  const page = h("div", { class: "page" }, pageHead("サイトへの招待"));
  const info = await api(`/invite?token=${encodeURIComponent(token)}`);
  const error = h("div", { class: "error" });
  if (!info.valid) {
    page.append(h("section", { class: "card" }, h("p", { class: "muted", text: "この招待リンクは使えません（使用済み・期限切れ・取り消し済みのいずれか）。" })));
  } else if (isAdmin()) {
    page.append(h("section", { class: "card" }, h("p", { class: "muted", text: `サイト ${info.site} への招待リンクです。管理者はすべてのサイトを扱えるので、参加の必要はありません。メンバーになる人にこのリンクを渡してください。` })));
  } else {
    const join = h("button", { class: "primary", text: "参加する" });
    join.addEventListener("click", async () => {
      join.disabled = true;
      try {
        const { site } = await api("/invite/accept", { method: "POST", body: JSON.stringify({ token }) });
        await loadOverview();
        go(siteHash("deployments", site));
      } catch (err) {
        error.textContent = err.message;
        join.disabled = false;
      }
    });
    page.append(h("section", { class: "card" }, h("h2", { text: `サイト ${info.site}` }), h("p", { class: "muted", text: `${state.overview.me.name} として、このサイトのメンバーに参加します。` }), join, error));
  }
  main.replaceChildren(page);
}

$("signin").addEventListener("click", async () => {
  $("login-error").textContent = "";
  try {
    const options = await api("/login/options", { method: "POST", body: "{}" });
    const cred = await navigator.credentials.get({ publicKey: requestOptions(options) });
    await api("/login/verify", { method: "POST", body: JSON.stringify({ response: credentialJSON(cred) }) });
    await enterApp();
  } catch (err) {
    $("login-error").textContent = err.message;
  }
});

$("logout").addEventListener("click", async () => {
  try {
    await api("/logout", { method: "POST", body: "{}" });
  } catch (err) {
    setMenu(false);
    $("main").querySelector(".logout-error")?.remove();
    $("main").prepend(h("div", { class: "notice logout-error", role: "alert", text: err.message }));
    return;
  }
  showAuth("login");
});

// ---------- shell ----------

function setMenu(open) {
  $("sidebar").classList.toggle("open", open);
  $("scrim").hidden = !open;
}
$("menu-open").addEventListener("click", () => setMenu(true));
$("scrim").addEventListener("click", () => setMenu(false));

/** 画面を移る。同じハッシュのときは hashchange が起きないので、自分で描き直す */
function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

const siteHash = (tab, name = state.siteName) => (name ? `#/${encodeURIComponent(name)}/${tab}` : "#/new");

for (const a of $("nav").querySelectorAll("a")) {
  a.addEventListener("click", (e) => {
    e.preventDefault();
    const tab = a.dataset.tab;
    go(SITE_TABS[tab] ? siteHash(tab) : `#/${tab}`);
    setMenu(false);
  });
}

// ---------- サイトの切り替え（自作のドロップダウン） ----------

const picker = { open: false, active: -1, items: [] };

function chooseSite(value) {
  closePicker(true);
  const tab = SITE_TABS[state.tab] ? state.tab : "deployments";
  const next = value === NEW_SITE ? "#/new" : siteHash(tab, value);
  setMenu(false);
  go(next);
}

const pickerItems = () => [...state.sites.sites.map((x) => x.name), ...(isAdmin() ? [NEW_SITE] : [])];

function renderPickerMenu() {
  const menu = $("site-menu");
  const selected = state.tab === "new" ? NEW_SITE : state.siteName;
  picker.items = pickerItems();
  const option = (value, i, ...children) =>
    h(
      "li",
      {
        id: `site-option-${i}`,
        role: "option",
        class: `site-option${value === NEW_SITE ? " add" : ""}${i === picker.active ? " active" : ""}`,
        "aria-selected": String(value === selected),
        onpointermove: () => setActive(i),
        onclick: () => chooseSite(value),
      },
      ...children,
    );
  const check = () => h("span", { html: '<svg class="check" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg>' }).firstChild;
  fill(
    menu,
    ...state.sites.sites.map((x, i) =>
      option(
        x.name,
        i,
        check(),
        h(
          "span",
          { class: "site-option-text" },
          h("span", { class: "site-option-name" }, x.name, kindBadge(x.kind)),
          h("span", { class: "site-option-host" }, x.name === state.sites.root ? h("span", { class: "root-badge", text: "ルート" }) : null, x.deployed ? hostOf(x.url) : `${hostOf(x.subdomainUrl)}・未デプロイ`),
        ),
      ),
    ),
    state.sites.sites.length ? (isAdmin() ? h("li", { class: "site-menu-sep", role: "presentation" }) : null) : h("li", { class: "site-menu-empty", role: "presentation", text: isAdmin() ? "サイトはまだありません" : "参加しているサイトはありません" }),
    isAdmin() ? option(NEW_SITE, picker.items.length - 1, check(), h("span", { class: "site-option-text" }, h("span", { class: "site-option-name", text: "＋ サイトを追加" }))) : null,
  );
  if (picker.active >= 0) menu.setAttribute("aria-activedescendant", `site-option-${picker.active}`);
  else menu.removeAttribute("aria-activedescendant");
}

function setActive(i) {
  if (i === picker.active) return;
  picker.active = i;
  const menu = $("site-menu");
  for (const el of menu.querySelectorAll(".site-option")) el.classList.toggle("active", el.id === `site-option-${i}`);
  menu.setAttribute("aria-activedescendant", `site-option-${i}`);
  $(`site-option-${i}`)?.scrollIntoView({ block: "nearest" });
}

function openPicker() {
  if (picker.open) return;
  picker.open = true;
  const selected = state.tab === "new" ? NEW_SITE : state.siteName;
  picker.active = Math.max(0, pickerItems().indexOf(selected));
  renderPickerMenu();
  $("site-menu").hidden = false;
  $("site-trigger").setAttribute("aria-expanded", "true");
  $("site-menu").focus();
  $(`site-option-${picker.active}`)?.scrollIntoView({ block: "nearest" });
}

function closePicker(focusTrigger = false) {
  if (!picker.open) return;
  picker.open = false;
  $("site-menu").hidden = true;
  $("site-trigger").setAttribute("aria-expanded", "false");
  if (focusTrigger) $("site-trigger").focus();
}

$("site-trigger").addEventListener("click", () => (picker.open ? closePicker(true) : openPicker()));
$("site-trigger").addEventListener("keydown", (e) => {
  if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
    e.preventDefault();
    openPicker();
  }
});
$("site-menu").addEventListener("keydown", (e) => {
  const last = picker.items.length - 1;
  const moves = { ArrowDown: Math.min(last, picker.active + 1), ArrowUp: Math.max(0, picker.active - 1), Home: 0, End: last };
  if (e.key in moves) {
    e.preventDefault();
    setActive(moves[e.key]);
  } else if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    if (picker.active >= 0) chooseSite(picker.items[picker.active]);
  } else if (e.key === "Escape") {
    e.preventDefault();
    closePicker(true);
  } else if (e.key === "Tab") {
    closePicker();
  }
});
document.addEventListener("pointerdown", (e) => {
  if (picker.open && !$("site-picker").contains(e.target)) closePicker();
});

const hostOf = (url) => url.replace(/^https?:\/\//, "").replace(/\/$/, "");

const siteApi = (path = "") => `/sites/${encodeURIComponent(state.siteName)}${path}`;

async function loadOverview() {
  [state.overview, state.sites] = await Promise.all([api("/overview"), api("/sites")]);
}

function renderShell() {
  const current = state.tab === "new" ? null : state.sites.sites.find((x) => x.name === state.siteName);
  const name = $("site-trigger-name");
  name.textContent = current ? current.name : state.tab === "new" ? "＋ サイトを追加" : state.sites.sites.length ? "サイトを選択" : isAdmin() ? "サイトがありません" : "参加しているサイトはありません";
  name.classList.toggle("placeholder", !current && state.tab !== "new");
  fill($("site-trigger-host"), current ? [kindBadge(current.kind), current.deployed ? hostOf(current.url) : `${hostOf(current.subdomainUrl)}・未デプロイ`] : []);
  closePicker();
  for (const a of $("nav").querySelectorAll("a")) {
    a.classList.toggle("current", a.dataset.tab === state.tab);
    a.hidden = (!!SITE_TABS[a.dataset.tab] && !current) || (DEPLOYED_TABS.has(a.dataset.tab) && !current?.deployed) || (ADMIN_TABS.has(a.dataset.tab) && !isAdmin());
  }
  $("topbar-title").textContent = current ? current.name : GLOBAL_TABS[state.tab] ?? "";
}

async function enterApp() {
  await loadOverview();
  $("auth").hidden = true;
  $("app").hidden = false;
  route();
}

function parseHash() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  // 以前の全体のリポジトリの URL（#/repos/<名前>）は、そのサイトのリポジトリのタブへ
  if (parts[0] === "repos") return { site: parts[1] ?? null, tab: "repo" };
  if (parts[0] === "invite") return { site: null, tab: "invite", invite: parts[1] ?? "" };
  if (parts.length >= 2) return { site: parts[0], tab: parts[1] };
  return { site: null, tab: parts[0] ?? "" };
}

function route() {
  if ($("app").hidden) return;
  clearTimers();
  const names = state.sites.sites.map((x) => x.name);
  const { site, tab, invite } = parseHash();
  // サイトがないときの行き先。メンバーはサイトを作れないので個人の設定へ
  const home = isAdmin() ? "#/new" : "#/settings";
  const deployed = (n) => state.sites.sites.find((x) => x.name === n)?.deployed;
  if (site && SITE_TABS[tab] && names.includes(site) && DEPLOYED_TABS.has(tab) && !deployed(site)) {
    location.replace(siteHash("deployments", site));
    return;
  } else if (site && SITE_TABS[tab] && names.includes(site)) {
    if (location.hash.startsWith("#/repos")) return location.replace(siteHash(tab, site));
    state.siteName = site;
  } else if (tab === "invite") {
    if (!names.includes(state.siteName)) state.siteName = names[0] ?? null;
  } else if (GLOBAL_TABS[tab] && !(ADMIN_TABS.has(tab) && !isAdmin())) {
    if (!names.includes(state.siteName)) state.siteName = names[0] ?? null;
  } else {
    // 不明な URL・権限のないタブは最初のサイト（なければサイトの追加か設定）へ
    const first = names.includes(state.siteName) ? state.siteName : (state.sites.root && names.includes(state.sites.root) ? state.sites.root : names[0]);
    location.replace(first ? siteHash(SITE_TABS[tab] ? tab : "deployments", first) : home);
    return;
  }
  state.tab = tab;
  renderShell();
  const main = $("main");
  main.className = `main${tab === "code" ? " fill" : ""}`;
  main.scrollTop = 0;
  const views = {
    deployments: viewDeployments,
    code: viewCode,
    observability: viewObservability,
    site: viewSite,
    new: viewNewSite,
    repo: viewRepoTab,
    database: viewDatabase,
    storage: viewStorage,
    resources: viewResources,
    settings: viewSettings,
    admin: viewAdmin,
    invite: (m) => viewInvite(m, invite),
  };
  views[tab](main).catch((err) => {
    main.className = "main";
    main.replaceChildren(h("div", { class: "page" }, h("div", { class: "notice", text: err.message })));
  });
}
window.addEventListener("hashchange", route);

function pageHead(title, extra = []) {
  return h(
    "div",
    { class: "page-head" },
    h("h1", { text: title }),
    ...extra,
    h("span", { class: "spacer" }),
    SITE_TABS[state.tab] && state.site?.url ? h("a", { class: "open", href: state.site.url, target: "_blank", rel: "noopener", text: "サイトを開く ↗" }) : null,
  );
}


function statusBadge(status) {
  return status === "success" ? h("span", { class: "status good", text: "成功" }) : h("span", { class: "status bad", text: "失敗" });
}

function commitLink(source) {
  if (!source?.sha) return null;
  const short = source.sha.slice(0, 7);
  if (source.repository && source.serverUrl) {
    return h("a", { href: `${source.serverUrl}/${source.repository}/commit/${source.sha}`, target: "_blank", rel: "noopener", class: "mono", text: short });
  }
  return h("span", { class: "mono", text: short });
}

// ---------- デプロイ ----------

function siteUrlCell(detail) {
  const link = (url) => h("a", { href: url, target: "_blank", rel: "noopener", text: url });
  if (detail.url === detail.subdomainUrl) return link(detail.url);
  return h("div", { class: "urls" }, link(detail.url), h("span", { class: "muted" }, "サブドメイン: ", link(detail.subdomainUrl)));
}

async function loadSite() {
  state.site = await api(siteApi());
  return state.site;
}

async function viewDeployments(main) {
  const [detail, { deployments, active }] = await Promise.all([loadSite(), api(siteApi("/deployments"))]);
  const page = h("div", { class: "page" }, pageHead("デプロイ"));
  if (detail.release) page.append(kindBanner(releaseKind(detail.release)));

  if (!detail.deployed) {
    page.append(h("section", { class: "card" }, h("h2", { text: "デプロイ方法を選ぶ" }), h("p", { class: "muted", text: `サイト ${detail.name}（${hostOf(detail.subdomainUrl)}）はまだデプロイされていません。次のどれかの方法でデプロイしてください。` }), deployOptions(detail)));
  }

  const latest = detail.latest;
  if (latest && latest.status === "failed" && (!detail.release || latest.id !== detail.release.deployment?.id)) {
    page.append(h("div", { class: "notice" }, h("b", { text: `直近のデプロイ（${fmtAgo(latest.createdAt)}）は失敗しました` }), h("div", { class: "mono", text: latest.error ?? "" })));
  }

  const current = h("section", { class: "card" }, h("div", { class: "card-head" }, h("h2", { text: "現在のデプロイ" }), detail.release ? h("span", { class: "status good", text: "アクティブ" }) : h("span", { class: "status neutral", text: "未公開" })));
  if (detail.release) {
    const d = detail.release.deployment;
    const s = d?.source ?? {};
    const rows = [
      ["名前", detail.release.name],
      ["デプロイ日時", `${fmtDate(detail.release.deployedAt)}（${fmtAgo(detail.release.deployedAt)}）`],
      ["URL", siteUrlCell(detail)],
      ["リリース", h("span", { class: "mono", text: detail.release.id })],
      s.commitMessage || s.sha ? ["コミット", h("span", {}, commitLink(s), s.commitMessage ? ` ${s.commitMessage}` : "")] : null,
      s.ref ? ["ブランチ", s.ref] : null,
      s.actor ? ["実行者", s.actor] : null,
      s.runUrl ? ["Actions", h("a", { href: s.runUrl, target: "_blank", rel: "noopener", text: "実行ログを開く ↗" })] : null,
      d ? ["サイズ", `${fmtBytes(d.size)}（${d.files} ファイル）・${fmtMs(d.durationMs)}`] : null,
      ["構成", h("div", { class: "tags" }, ...bindingTags(detail.release))],
    ].filter(Boolean);
    current.append(h("dl", { class: "kv" }, ...rows.flatMap(([k, v]) => [h("dt", { text: k }), h("dd", {}, v)])));
  } else {
    current.append(h("p", { class: "muted", text: "成功したデプロイがまだありません。" }));
  }
  // 未デプロイのサイトでは、上の「デプロイ方法を選ぶ」があるので出さない
  if (detail.deployed) page.append(current);

  page.append(h("div", { class: "section-head" }, h("h2", { text: "デプロイ履歴" }), h("span", { class: "muted", text: `${deployments.length} 件` })));
  const list = h("div", { class: "list" });
  for (const d of deployments) list.append(deploymentItem(d, d.release && d.release === active));
  if (!deployments.length) list.append(h("div", { class: "empty", text: "履歴はまだありません" }));
  page.append(list);

  // デプロイ済みのサイトでは、別の方法でのデプロイを一番下に折りたたんで出す
  if (detail.deployed) {
    const icon = h("span", { class: "deploy-again-icon", html: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3M7 8l5-5 5 5M5 21h14"/></svg>' });
    const chevron = h("span", { class: "deploy-again-chevron", html: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>' });
    page.append(
      h(
        "details",
        { class: "card deploy-again" },
        h(
          "summary",
          {},
          icon,
          h("span", { class: "grow" }, h("b", { text: "新しくデプロイ" }), h("span", { class: "muted", text: "別の方法でデプロイして、今のリリースを置き換えます" })),
          chevron,
        ),
        deployOptions(detail),
      ),
    );
  }
  main.replaceChildren(page);
}

// ---------- 動的 / 静的 ----------

const KIND = {
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
const releaseKind = (release) => (release ? (release.main ? "dynamic" : "static") : null);

/** 小さいバッジ（サイトの切り替え・一覧用） */
function kindBadge(kind) {
  if (!kind) return null;
  return h("span", { class: `kind-badge ${kind}`, text: KIND[kind].label, title: KIND[kind].title });
}

/** 大きめの表示（デプロイ・サイト設定の上） */
function kindBanner(kind) {
  const k = KIND[kind];
  return h(
    "section",
    { class: `kind-banner ${kind}` },
    h("span", { class: "kind-icon", html: k.icon }),
    h("div", { class: "kind-body" }, h("div", { class: "kind-eyebrow", text: "サイトの種類" }), h("div", { class: "kind-title", text: k.title }), h("p", { text: k.text })),
  );
}

function bindingTags(release) {
  return [
    release.main ? h("span", { class: "tag", text: "Worker" }) : null,
    release.assets ? h("span", { class: "tag", text: "Assets" }) : null,
    ...release.kv.map((b) => h("span", { class: "tag", text: `KV: ${b}` })),
    ...release.r2.map((b) => h("span", { class: "tag", text: `R2: ${b.binding}` })),
  ].filter(Boolean);
}

async function deployGitHub(body, onError) {
  let site;
  try {
    try {
      ({ site } = await api("/deploy-github", { method: "POST", body: JSON.stringify(body) }));
    } catch (err) {
      if (!/既にあります/.test(err.message) || !confirm(`サイト ${body.name} は既にあります。上書きしてデプロイしますか？\n（KV / R2 のデータは残ります）`)) throw err;
      ({ site } = await api("/deploy-github", { method: "POST", body: JSON.stringify({ ...body, confirm: true }) }));
    }
  } catch (err) {
    onError(err.message);
    return;
  }
  await afterDeploy(site);
}

/** デプロイが終わったら、一覧を読み直してデプロイタブを開く */
async function afterDeploy(site) {
  // デプロイは成功しているので、一覧の再読み込みに失敗してもエラーにしない
  await loadOverview().catch(() => {});
  // 同じサイトのデプロイタブからデプロイしたときは hashchange が起きないので、go が描き直す
  go(siteHash("deployments", site));
}

function busy(button, label) {
  button.disabled = true;
  button.textContent = label;
}

function deploymentItem(d, isActive) {
  const s = d.source ?? {};
  const item = h("div", { class: "list-item" });
  const detail = h("div", { class: "list-detail" });
  detail.hidden = true;
  const title = s.commitMessage || (d.status === "failed" ? d.error : null) || "コミット情報なし";
  const sub = [fmtDate(d.createdAt), s.sha ? s.sha.slice(0, 7) : null, s.ref, s.actor].filter(Boolean).join(" · ");
  const row = h(
    "button",
    {
      class: "list-row",
      "aria-expanded": "false",
      onclick: async () => {
        const open = detail.hidden;
        detail.hidden = !open;
        row.setAttribute("aria-expanded", String(open));
        if (open && !detail.dataset.loaded) {
          detail.dataset.loaded = "1";
          detail.replaceChildren(h("p", { class: "muted", text: "読み込み中…" }));
          try {
            const full = await api(state.tab === "new" ? `/deployments/${encodeURIComponent(d.id)}` : siteApi(`/deployments/${encodeURIComponent(d.id)}`));
            fill(
              detail,
              full.error ? h("div", { class: "notice mono", text: full.error }) : null,
              s.runUrl ? h("a", { href: s.runUrl, target: "_blank", rel: "noopener", text: "GitHub Actions の実行ログを開く ↗" }) : null,
              h("div", { class: "log-title", text: "ビルドログ（GitHub Actions）" }),
              h("pre", { class: "log", text: full.buildLog || "（ビルドログはありません）" }),
              h("div", { class: "log-title", text: "Kanzume のログ" }),
              h("pre", { class: "log", text: full.log }),
            );
          } catch (err) {
            detail.replaceChildren(h("div", { class: "notice", text: err.message }));
          }
        }
      },
    },
    statusBadge(d.status),
    h("div", { class: "grow" }, h("div", { class: "title", text: title }), h("div", { class: "sub", text: sub })),
    h("div", { class: "side" }, isActive ? h("span", { class: "tag", text: "アクティブ" }) : null, h("div", { text: fmtMs(d.durationMs) })),
  );
  item.append(row, detail);
  return item;
}

// ---------- コード ----------

const GROUPS = [
  ["source", "ソースコード"],
  ["config", "設定"],
  ["worker", "Worker（変換後）"],
  ["assets", "アセット"],
];

function buildTree(files) {
  const root = { dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    for (const dir of parts.slice(0, -1)) {
      if (!node.dirs.has(dir)) node.dirs.set(dir, { dirs: new Map(), files: [] });
      node = node.dirs.get(dir);
    }
    node.files.push({ ...f, name: parts[parts.length - 1] });
  }
  return root;
}

async function viewCode(main) {
  const [{ groups }] = await Promise.all([api(siteApi("/files")), loadSite()]);
  const page = h("div", { class: "page" }, pageHead("コード", [h("span", { class: "muted", text: "読み取り専用" })]));

  const all = GROUPS.flatMap(([g]) => groups[g].map((f) => ({ group: g, ...f })));
  if (!all.some((f) => f.group === state.code.group && f.path === state.code.path)) {
    const pick = all.find((f) => f.group === "source") ?? all.find((f) => f.group === "worker") ?? all[0];
    state.code = pick ? { group: pick.group, path: pick.path } : { group: null, path: null };
  }

  const tree = h("nav", { class: "tree" });
  const mobile = h("select", { class: "mobile-file", "aria-label": "ファイル" });
  const viewer = h("div", { class: "viewer" });
  const buttons = [];

  const select = (group, path) => {
    state.code = { group, path };
    for (const b of buttons) b.classList.toggle("current", b.dataset.group === group && b.dataset.path === path);
    mobile.value = `${group}:${path}`;
    showFile(viewer, group, path);
  };

  const renderNode = (node, group, depth) => {
    const out = [];
    for (const [dir, child] of [...node.dirs].sort(([a], [b]) => a.localeCompare(b))) {
      const details = h("details", { open: depth < 2 || undefined });
      const summary = h("summary", { text: dir });
      summary.style.paddingLeft = `${14 + depth * 12}px`;
      details.append(summary, ...renderNode(child, group, depth + 1));
      out.push(details);
    }
    for (const f of node.files) {
      const b = h("button", { class: "file", title: f.path, "data-group": group, "data-path": f.path, text: f.name, onclick: () => select(group, f.path) });
      b.style.paddingLeft = `${14 + depth * 12}px`;
      buttons.push(b);
      out.push(b);
    }
    return out;
  };

  for (const [g, label] of GROUPS) {
    if (!groups[g].length) continue;
    tree.append(h("div", { class: "tree-group", text: label }), ...renderNode(buildTree(groups[g]), g, 0));
    mobile.append(h("optgroup", { label }, ...groups[g].map((f) => h("option", { value: `${g}:${f.path}`, text: f.path }))));
  }
  mobile.addEventListener("change", () => {
    const [g, ...rest] = mobile.value.split(":");
    select(g, rest.join(":"));
  });
  if (!groups.source.length) {
    tree.prepend(h("p", { class: "muted", text: "ソースコードは Kanzume の Action でデプロイすると表示されます。" }));
    tree.firstChild.style.padding = "8px 14px";
  }

  page.append(mobile, h("div", { class: "code-layout" }, tree, viewer));
  main.replaceChildren(page);
  if (state.code.group) select(state.code.group, state.code.path);
  else viewer.append(h("div", { class: "placeholder", text: "ファイルがありません" }));
}

async function showFile(viewer, group, path) {
  viewer.replaceChildren(h("div", { class: "viewer-head" }, h("span", { class: "path", text: path })), h("div", { class: "placeholder", text: "読み込み中…" }));
  const file = await api(siteApi(`/file?group=${group}&path=${encodeURIComponent(path)}`)).catch((err) => ({ error: err.message }));
  if (state.code.group !== group || state.code.path !== path) return;
  renderFile(viewer, path, file, group === "assets" && state.site ? state.site.url + path : null);
}

function renderFile(viewer, path, file, publicUrl = null) {
  const head = h(
    "div",
    { class: "viewer-head" },
    h("span", { class: "path", text: path }),
    file.size !== undefined ? h("span", { class: "muted", text: fmtBytes(file.size) }) : null,
    file.truncated ? h("span", { class: "muted", text: "先頭 1 MiB のみ表示" }) : null,
  );
  if (file.error) return viewer.replaceChildren(head, h("div", { class: "placeholder", text: file.error }));
  if (file.binary) {
    return viewer.replaceChildren(
      head,
      h("div", { class: "placeholder" }, "バイナリファイルのため表示できません。", publicUrl ? h("a", { href: publicUrl, target: "_blank", rel: "noopener", text: " 公開 URL で開く ↗" }) : null),
    );
  }
  const text = file.text;
  const lines = text.split("\n").length;
  const gutter = h("pre", { class: "gutter", "aria-hidden": "true", text: Array.from({ length: lines }, (_, i) => i + 1).join("\n") });
  const code = h("pre", { class: "lines", html: highlight(text, path) });
  viewer.replaceChildren(head, h("div", { class: "viewer-body" }, h("div", { class: "code-view" }, gutter, code)));
}

const KEYWORDS =
  "const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|import|from|export|default|async|await|try|catch|finally|throw|typeof|instanceof|in|of|this|null|undefined|true|false|interface|type|satisfies|as|implements|enum|public|private|protected|readonly|static|get|set|yield|void|delete|super|declare|keyof";

const RULES = {
  js: new RegExp(
    [
      String.raw`(\/\/[^\n]*|\/\*[\s\S]*?\*\/)`,
      String.raw`("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\x60(?:\\.|[^\x60\\])*\x60)`,
      String.raw`\b(0x[\da-fA-F]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)\b`,
      String.raw`\b(${KEYWORDS})\b`,
    ].join("|"),
    "g",
  ),
  json: /()("(?:\\.|[^"\\\n])*")|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b|\b(true|false|null)\b/g,
  jsonc: /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\\n])*")|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b|\b(true|false|null)\b/g,
  toml: /(#[^\n]*)|("(?:\\.|[^"\\\n])*"|'[^'\n]*')|\b(\d[\d_]*(?:\.\d+)?)\b|(^\s*\[\[?[^\]\n]+\]\]?|\b(?:true|false)\b)/gm,
  css: /(\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|(#[\da-fA-F]{3,8}\b|-?\b\d+(?:\.\d+)?(?:px|rem|em|%|vh|vw|s|ms|fr|deg)?\b)|(@[\w-]+|![\w]+)/g,
  html: /(<!--[\s\S]*?-->)|("(?:[^"\n])*"|'(?:[^'\n])*')|()(<\/?[A-Za-z][\w-]*|\/?>)/g,
};
const EXT = { js: "js", mjs: "js", cjs: "js", jsx: "js", ts: "js", tsx: "js", mts: "js", cts: "js", json: "json", map: "json", jsonc: "jsonc", toml: "toml", css: "css", html: "html", htm: "html", svg: "html", xml: "html" };

function highlight(text, path) {
  const lang = EXT[path.split(".").pop()?.toLowerCase()];
  if (!lang || text.length > 400_000) return esc(text);
  const re = RULES[lang];
  const classes = ["tk-c", "tk-s", "tk-n", lang === "html" || lang === "toml" ? "tk-t" : "tk-k"];
  let out = "";
  let last = 0;
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0] === "") {
      re.lastIndex++;
      continue;
    }
    const i = [1, 2, 3, 4].find((g) => m[g]);
    if (!i) continue;
    out += `${esc(text.slice(last, m.index))}<span class="${classes[i - 1]}">${esc(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}

// ---------- 可観測性 ----------

const RANGES = [
  ["1h", "1 時間"],
  ["24h", "24 時間"],
  ["3d", "3 日"],
];
const RANGE_MS = { "1h": 3600e3, "24h": 86400e3, "3d": 3 * 86400e3 };

async function viewObservability(main) {
  await loadSite();
  const o = state.obs;
  const page = h("div", { class: "page" });
  const body = h("div");
  const seg = (items, value, onPick) =>
    h("div", { class: "segmented", role: "group" }, ...items.map(([v, label]) => h("button", { class: v === value ? "active" : "", "aria-pressed": String(v === value), text: label, onclick: () => onPick(v) })));
  page.append(
    pageHead("可観測性", [seg([["overview", "概要"], ["events", "イベント"]], o.view, (v) => {
      o.view = v;
      route();
    })]),
    h("div", { class: "filters" }, seg(RANGES, o.range, (v) => {
      o.range = v;
      route();
    })),
    body,
  );
  main.replaceChildren(page);
  if (o.view === "overview") await renderMetrics(body);
  else await renderEvents(body, page.querySelector(".filters"));
}

async function renderMetrics(body) {
  const load = async () => {
    const m = await api(siteApi(`/metrics?range=${state.obs.range}`));
    if (state.tab !== "observability") return;
    drawMetrics(body, m);
  };
  await load();
  state.timers.push(setInterval(() => load().catch(() => {}), 15_000));
}

function drawMetrics(body, m) {
  const t = m.totals;
  const errorRate = t.requests ? (t.errors / t.requests) * 100 : 0;
  const tile = (label, value, note) => h("div", { class: "tile" }, h("div", { class: "label", text: label }), h("div", { class: "value", text: value }), h("div", { class: "note", text: note }));
  const withDate = m.range !== "1h";
  const xLabel = (v) => fmtShort(v, withDate);

  const requests = h("div", { class: "chart" });
  const latency = h("div", { class: "chart" });
  body.replaceChildren(
    h(
      "div",
      { class: "tiles" },
      tile("リクエスト", fmtCount(t.requests), `Worker ${fmtCount(t.worker)} / アセット ${fmtCount(t.requests - t.worker)}`),
      tile("エラー", fmtCount(t.errors), `${errorRate.toFixed(errorRate && errorRate < 1 ? 2 : 1)}%（5xx・例外）`),
      tile("実行時間 p50", fmtMs(t.p50), `p95 ${fmtMs(t.p95)}`),
      tile("実行時間 p99", fmtMs(t.p99), `2xx ${t.statuses["2xx"]} · 3xx ${t.statuses["3xx"]} · 4xx ${t.statuses["4xx"]} · 5xx ${t.statuses["5xx"]}`),
    ),
    h(
      "div",
      { class: "charts" },
      h(
        "section",
        { class: "chart-card" },
        h("h2", { text: "リクエスト数" }),
        h("div", { class: "legend" }, h("span", {}, h("i", { class: "key s1" }), "成功"), h("span", {}, h("i", { class: "key err" }), "エラー")),
        requests,
        tableView(["時刻", "成功", "エラー"], m.buckets.map((b) => [xLabel(b.t), b.ok, b.errors])),
      ),
      h(
        "section",
        { class: "chart-card" },
        h("h2", { text: "実行時間" }),
        h("div", { class: "legend" }, h("span", {}, h("i", { class: "key line s1" }), "p50"), h("span", {}, h("i", { class: "key line s2" }), "p99")),
        latency,
        tableView(["時刻", "p50", "p99"], m.buckets.map((b) => [xLabel(b.t), fmtMs(b.p50), fmtMs(b.p99)])),
      ),
    ),
  );
  const draw = () => {
    stackedColumns(requests, m.buckets, [
      { key: "ok", label: "成功", cls: "fill-1", keyCls: "s1" },
      { key: "errors", label: "エラー", cls: "fill-err", keyCls: "err" },
    ], xLabel, (v) => fmtCount(v));
    lineChart(latency, m.buckets, [
      { key: "p50", label: "p50", cls: "1" },
      { key: "p99", label: "p99", cls: "2" },
    ], xLabel, fmtMs);
  };
  draw();
  const ro = new ResizeObserver(() => draw());
  ro.observe(requests);
}

// ---------- resources ----------

const SOURCE_NOTE = {
  cgroup2: "コンテナ（cgroup v2）の値です。",
  cgroup1: "コンテナ（cgroup v1）の値です。",
  process: "cgroup を読めないため、Node プロセスとマシン全体の値を表示しています。",
};

const fmtPct = (v) => (v === null || v === undefined ? "–" : `${v < 10 ? v.toFixed(1) : Math.round(v)}%`);
const fmtCores = (v) => (v === null || v === undefined ? "–" : v < 1 ? v.toFixed(3).replace(/0+$/, "").replace(/\.$/, "") : v.toFixed(2).replace(/\.?0+$/, ""));
const fmtMiB = (n) => (n === null || n === undefined ? "–" : `${(n / 1024 / 1024).toFixed(n < 100 * 1024 * 1024 ? 1 : 0)} MiB`);

async function viewResources(main) {
  const page = h("div", { class: "page" });
  const body = h("div");
  page.append(pageHead("リソース"), body);
  main.replaceChildren(page);
  let draw = null;
  const load = async () => {
    const r = await api("/resources");
    if (state.tab !== "resources") return;
    draw = drawResources(body, r, draw);
  };
  await load();
  state.timers.push(setInterval(() => load().catch(() => {}), 5000));
}

function drawResources(body, r, prev) {
  const { cpu: cpuLimit, memory: memLimit } = r.limits;
  const latest = r.samples.at(-1);
  // 上限がなければ docker stats と同じく 1 コア = 100% で表す
  const cpuPct = (v) => (v === null || v === undefined ? null : (v / (cpuLimit ?? 1)) * 100);
  const buckets = r.samples.map((s) => ({ t: s.t, cpu: cpuPct(s.cpu), memory: s.memory / 1024 / 1024, heap: s.heap / 1024 / 1024 }));
  const peakCpu = Math.max(0, ...buckets.map((b) => b.cpu ?? 0));
  const peakMem = Math.max(0, ...r.samples.map((s) => s.memory));
  const workers = r.workers ?? [];
  const workerRss = workers.reduce((sum, w) => sum + (w.rss ?? 0), 0);
  const tile = (label, value, note) => h("div", { class: "tile" }, h("div", { class: "label", text: label }), h("div", { class: "value", text: value }), h("div", { class: "note", text: note }));
  const xLabel = (v) => fmtTime(v);

  if (!prev) {
    const cpu = h("div", { class: "chart" });
    const memory = h("div", { class: "chart" });
    const tiles = h("div", { class: "tiles" });
    const tables = [h("div"), h("div")];
    const workers = h("div");
    body.replaceChildren(
      tiles,
      h(
        "div",
        { class: "charts" },
        h("section", { class: "chart-card" }, h("h2", { text: "CPU" }), h("div", { class: "legend" }, h("span", {}, h("i", { class: "key line s1" }), cpuLimit ? "上限に対する使用率" : "使用率（1 コア = 100%）")), cpu, tables[0]),
        h("section", { class: "chart-card" }, h("h2", { text: "メモリ" }), h("div", { class: "legend" }, h("span", {}, h("i", { class: "key line s1" }), "コンテナ"), h("span", {}, h("i", { class: "key line s2" }), "JS ヒープ")), memory, tables[1]),
      ),
      workers,
      h("p", { class: "muted hint", text: `${SOURCE_NOTE[r.source]}${r.limits.cpuRaw ? `CPU の上限は ${r.limits.cpuRaw} から計算した、実際にかかっている上限です（ホスティングの公称値と違うことがあります）。` : ""}${Math.round(r.intervalMs / 1000)} 秒ごとに計測した直近 30 分ぶんを表示します（サーバーを再起動すると消えます）。` }),
    );
    prev = { cpu, memory, tiles, tables, workers, data: null };
    new ResizeObserver(() => prev.data && prev.render()).observe(cpu);
  }
  prev.data = { buckets, xLabel };
  prev.render = () => {
    const { buckets, xLabel } = prev.data;
    if (!buckets.length) return;
    lineChart(prev.cpu, buckets, [{ key: "cpu", label: "CPU", cls: "1" }], xLabel, fmtPct, "CPU 使用率の推移");
    lineChart(prev.memory, buckets, [{ key: "memory", label: "コンテナ", cls: "1" }, { key: "heap", label: "JS ヒープ", cls: "2" }], xLabel, (v) => `${Math.round(v)} MiB`, "メモリ使用量の推移");
  };
  fill(
    prev.tiles,
    tile("CPU", fmtPct(cpuPct(latest?.cpu)), cpuLimit ? `${fmtCores(latest?.cpu)} / ${fmtCores(cpuLimit)} CPU` : `${fmtCores(latest?.cpu)} CPU（上限なし・1 コア = 100%）`),
    tile("CPU（30 分の最大）", fmtPct(peakCpu), `${fmtCores((peakCpu / 100) * (cpuLimit ?? 1))} CPU`),
    tile("メモリ", fmtMiB(latest?.memory), `${memLimit ? `上限 ${fmtMiB(memLimit)}（${fmtPct((latest.memory / memLimit) * 100)}）` : "上限なし"} · 30 分の最大 ${fmtMiB(peakMem)}`),
    tile("Node プロセス", fmtMiB(latest?.rss), `JS ヒープ ${fmtMiB(latest?.heap)}`),
  );
  fill(
    prev.workers,
    h(
      "section",
      { class: "card workers-card" },
      h("div", { class: "card-head" }, h("h2", { text: "Worker のプロセス" }), h("span", { class: "muted", text: workers.length ? `${workers.length} 個 · 合計 ${fmtMiB(workerRss)}` : "0 個" })),
      h("p", { class: "muted hint", text: `動的サイト ${state.sites.sites.filter((x) => x.kind === "dynamic").length} 個・静的サイト ${state.sites.sites.filter((x) => x.kind === "static").length} 個。Worker 付きのサイトは、サイトごとに別のユーザーの子プロセスで動きます。しばらく使われないと止まり、次のアクセスで起動します。静的サイトはプロセスを使いません。` }),
      workers.length
        ? h("div", { class: "scroll" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", { text: "サイト" }), h("th", { class: "num", text: "PID" }), h("th", { class: "num", text: "メモリ" }))), h("tbody", {}, ...workers.map((w) => h("tr", {}, h("td", { text: w.site }), h("td", { class: "num", text: String(w.pid) }), h("td", { class: "num", text: fmtMiB(w.rss) }))))))
        : null,
    ),
  );
  const keepOpen = (el) => el.querySelector("details")?.open;
  const [t0, t1] = prev.tables;
  const o0 = keepOpen(t0);
  const o1 = keepOpen(t1);
  fill(t0, tableView(["時刻", "CPU"], buckets.map((b) => [xLabel(b.t), fmtPct(b.cpu)])));
  fill(t1, tableView(["時刻", "コンテナ", "JS ヒープ"], r.samples.map((s) => [xLabel(s.t), fmtMiB(s.memory), fmtMiB(s.heap)])));
  if (o0) t0.querySelector("details").open = true;
  if (o1) t1.querySelector("details").open = true;
  prev.render();
  return prev;
}

function tableView(headers, rows) {
  return h(
    "details",
    { class: "table-view" },
    h("summary", { text: "表で見る" }),
    h("div", { class: "scroll" }, h("table", {}, h("thead", {}, h("tr", {}, ...headers.map((x, i) => h("th", { class: i ? "num" : "", text: x })))), h("tbody", {}, ...rows.filter((r) => r.slice(1).some((v) => v && v !== "–")).map((r) => h("tr", {}, ...r.map((v, i) => h("td", { class: i ? "num" : "", text: v }))))))),
  );
}

function niceScale(v) {
  const target = Math.max(v, 1e-9) / 4;
  const exp = 10 ** Math.floor(Math.log10(target));
  const step = [1, 2, 5, 10].map((m) => m * exp).find((m) => m >= target);
  const ticks = Math.max(1, Math.ceil(v / step));
  return { max: step * ticks, step, ticks };
}

const PAD = { l: 44, r: 8, t: 8, b: 22 };

function frame(el, scale, fmtY, buckets, xLabel) {
  const maxY = scale.max;
  const w = el.clientWidth || 300;
  const hgt = el.clientHeight || 190;
  const iw = w - PAD.l - PAD.r;
  const ih = hgt - PAD.t - PAD.b;
  const y = (v) => PAD.t + ih - (v / maxY) * ih;
  const band = iw / buckets.length;
  let svg = "";
  for (let i = 0; i <= scale.ticks; i++) {
    const v = scale.step * i;
    const yy = Math.round(y(v)) + 0.5;
    svg += `<line class="${i ? "grid" : "baseline"}" x1="${PAD.l}" x2="${w - PAD.r}" y1="${yy}" y2="${yy}"/>`;
    svg += `<text x="${PAD.l - 6}" y="${yy + 3.5}" text-anchor="end">${esc(fmtY(v))}</text>`;
  }
  const ticks = Math.max(2, Math.min(6, Math.floor(iw / 90)));
  for (let i = 0; i < ticks; i++) {
    const idx = Math.round((i / (ticks - 1)) * (buckets.length - 1));
    const x = PAD.l + band * idx + band / 2;
    svg += `<text x="${x}" y="${hgt - 6}" text-anchor="${i === 0 ? "start" : i === ticks - 1 ? "end" : "middle"}">${esc(xLabel(buckets[idx].t))}</text>`;
  }
  return { w, hgt, iw, ih, y, band, svg };
}

function tooltip(el, x, title, rows) {
  let tip = el.querySelector(".tooltip");
  if (!tip) {
    tip = h("div", { class: "tooltip" });
    el.append(tip);
  }
  tip.replaceChildren(h("div", { class: "t", text: title }), ...rows.map(([keyCls, label, value]) => h("div", { class: "r" }, h("i", { class: `key ${keyCls}` }), h("b", { text: value }), h("span", { class: "muted", text: label }))));
  tip.hidden = false;
  const right = x + 12;
  const left = right + tip.offsetWidth > el.clientWidth ? x - tip.offsetWidth - 12 : right;
  tip.style.left = `${Math.max(0, left)}px`;
  tip.style.top = "4px";
}

function hideTooltip(el) {
  const tip = el.querySelector(".tooltip");
  if (tip) tip.hidden = true;
}

function topRounded(x, y, w, hgt, r) {
  r = Math.min(r, hgt, w / 2);
  return `M${x},${y + hgt}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt}Z`;
}

function stackedColumns(el, buckets, series, xLabel, fmtY) {
  const f = frame(el, niceScale(Math.max(1, ...buckets.map((b) => series.reduce((n, s) => n + b[s.key], 0)))), fmtY, buckets, xLabel);
  const bw = Math.max(2, Math.min(24, f.band * 0.7));
  let marks = "";
  let hits = "";
  buckets.forEach((b, i) => {
    const x = PAD.l + f.band * i + (f.band - bw) / 2;
    let base = 0;
    const visible = series.filter((s) => b[s.key] > 0);
    visible.forEach((s, j) => {
      const v = b[s.key];
      const y0 = f.y(base);
      const y1 = f.y(base + v);
      const gap = j > 0 ? 2 : 0;
      const hgt = Math.max(1, y0 - y1 - gap);
      const top = y0 - gap - hgt;
      marks += j === visible.length - 1 ? `<path class="bar ${s.cls}" data-i="${i}" d="${topRounded(x, top, bw, hgt, 4)}"/>` : `<rect class="bar ${s.cls}" data-i="${i}" x="${x}" y="${top}" width="${bw}" height="${hgt}"/>`;
      base += v;
    });
    hits += `<rect class="hit" data-i="${i}" x="${PAD.l + f.band * i}" y="${PAD.t}" width="${f.band}" height="${f.ih}"/>`;
  });
  el.innerHTML = `<svg viewBox="0 0 ${f.w} ${f.hgt}" role="img" aria-label="リクエスト数の推移">${f.svg}${marks}${hits}</svg>`;
  const svg = el.querySelector("svg");
  svg.addEventListener("pointermove", (e) => {
    const i = Number(e.target.dataset?.i);
    if (Number.isNaN(i)) return hideTooltip(el);
    for (const m of svg.querySelectorAll(".bar")) m.classList.toggle("dim", Number(m.dataset.i) !== i);
    const b = buckets[i];
    tooltip(el, PAD.l + f.band * i + f.band / 2, xLabel(b.t), series.map((s) => [s.keyCls, s.label, fmtCount(b[s.key])]));
  });
  svg.addEventListener("pointerleave", () => {
    for (const m of svg.querySelectorAll(".bar")) m.classList.remove("dim");
    hideTooltip(el);
  });
}

function lineChart(el, buckets, series, xLabel, fmtY, label = "実行時間の推移") {
  const values = buckets.flatMap((b) => series.map((s) => b[s.key]).filter((v) => v !== null));
  const f = frame(el, niceScale(values.length ? Math.max(...values) : 1), fmtY, buckets, xLabel);
  const xOf = (i) => PAD.l + f.band * i + f.band / 2;
  let marks = "";
  for (const s of series) {
    let d = "";
    let pen = false;
    const dots = [];
    buckets.forEach((b, i) => {
      const v = b[s.key];
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${xOf(i).toFixed(1)},${f.y(v).toFixed(1)}`;
      const prev = buckets[i - 1]?.[s.key];
      const next = buckets[i + 1]?.[s.key];
      if ((prev === null || prev === undefined) && (next === null || next === undefined)) dots.push(i);
      pen = true;
    });
    marks += `<path class="line-${s.cls}" d="${d}"/>`;
    for (const i of dots) marks += `<circle class="dot-${s.cls}" cx="${xOf(i)}" cy="${f.y(buckets[i][s.key])}" r="4"/>`;
  }
  el.innerHTML = `<svg viewBox="0 0 ${f.w} ${f.hgt}" role="img" aria-label="${esc(label)}">${f.svg}${marks}<line class="crosshair" visibility="hidden" y1="${PAD.t}" y2="${PAD.t + f.ih}" x1="0" x2="0"/><g class="focus"></g><rect class="hit" x="${PAD.l}" y="${PAD.t}" width="${f.iw}" height="${f.ih}"/></svg>`;
  const svg = el.querySelector("svg");
  const cross = svg.querySelector(".crosshair");
  const focus = svg.querySelector(".focus");
  svg.addEventListener("pointermove", (e) => {
    const rect = svg.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * f.w;
    const i = Math.min(buckets.length - 1, Math.max(0, Math.floor((px - PAD.l) / f.band)));
    const x = xOf(i);
    cross.setAttribute("x1", x);
    cross.setAttribute("x2", x);
    cross.setAttribute("visibility", "visible");
    focus.innerHTML = series
      .filter((s) => buckets[i][s.key] !== null)
      .map((s) => `<circle class="dot-${s.cls}" cx="${x}" cy="${f.y(buckets[i][s.key])}" r="4"/>`)
      .join("");
    tooltip(el, x, xLabel(buckets[i].t), series.map((s) => [`line s${s.cls}`, s.label, fmtY(buckets[i][s.key])]));
  });
  svg.addEventListener("pointerleave", () => {
    cross.setAttribute("visibility", "hidden");
    focus.innerHTML = "";
    hideTooltip(el);
  });
}

function statusClass(e) {
  if (e.status >= 500 || e.outcome !== "ok") return "error";
  if (e.status >= 400) return "client";
  if (e.status >= 300) return "redirect";
  return "ok";
}

const OUTCOME = { ok: "OK", exception: "例外", exceededCpu: "時間超過", canceled: "切断" };

async function renderEvents(body, filters) {
  const o = state.obs;
  const result = h("select", { "aria-label": "結果" }, h("option", { value: "", text: "すべての結果" }), h("option", { value: "ok", text: "成功のみ" }), h("option", { value: "error", text: "エラーのみ" }));
  const kind = h("select", { "aria-label": "種類" }, h("option", { value: "", text: "すべての種類" }), h("option", { value: "worker", text: "Worker" }), h("option", { value: "asset", text: "アセット" }));
  const q = h("input", { type: "search", placeholder: "パス・ログを検索", value: o.q });
  result.value = o.result;
  kind.value = o.kind;
  const live = h("button", { class: o.live ? "active" : "", "aria-pressed": String(o.live) }, o.live ? h("span", { class: "live-dot" }) : null, "ライブ");
  filters.append(result, kind, q, live);

  const list = h("div", { class: "events" });
  const more = h("button", { class: "more", text: "さらに読み込む" });
  body.replaceChildren(list);

  let oldest = null;
  let newest = 0;
  const params = (extra) => {
    const p = new URLSearchParams({ limit: "50", from: String(Date.now() - RANGE_MS[o.range]), ...extra });
    if (o.result) p.set("result", o.result);
    if (o.kind) p.set("kind", o.kind);
    if (o.q) p.set("q", o.q);
    return p;
  };
  const header = () =>
    h("div", { class: "event-row head" }, h("span", { text: "時刻" }), h("span", { text: "ステータス" }), h("span", { text: "メソッド" }), h("span", { text: "パス" }), h("span", { class: "num", text: "実行時間" }), h("span", { class: "num", text: "ログ" }));

  const reload = async () => {
    const { events } = await api(siteApi(`/events?${params({})}`));
    list.replaceChildren(header(), ...events.map((e) => eventRow(e)));
    if (!events.length) list.append(h("div", { class: "empty", text: "この期間のイベントはありません" }));
    oldest = events.length ? events[events.length - 1].id : null;
    newest = events.length ? events[0].id : newest;
    if (events.length === 50) list.append(more);
  };

  more.addEventListener("click", async () => {
    more.disabled = true;
    const { events } = await api(siteApi(`/events?${params({ before: String(oldest) })}`));
    more.remove();
    for (const e of events) list.append(eventRow(e));
    oldest = events.length ? events[events.length - 1].id : oldest;
    more.disabled = false;
    if (events.length === 50) list.append(more);
  });

  const poll = async () => {
    const { events } = await api(siteApi(`/events?${params(newest ? { after: String(newest) } : {})}`));
    if (!events.length || state.tab !== "observability") return;
    list.querySelector(".empty")?.remove();
    const head = list.querySelector(".event-row.head");
    for (const e of events.reverse()) head.after(eventRow(e));
    newest = Math.max(newest, ...events.map((e) => e.id));
  };

  let timer = null;
  q.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      o.q = q.value.trim();
      reload();
    }, 300);
  });
  result.addEventListener("change", () => {
    o.result = result.value;
    reload();
  });
  kind.addEventListener("change", () => {
    o.kind = kind.value;
    reload();
  });
  live.addEventListener("click", () => {
    o.live = !o.live;
    route();
  });

  await reload();
  if (o.live) state.timers.push(setInterval(() => poll().catch(() => {}), 2000));
}

function eventRow(e) {
  const wrap = h("div");
  const detail = h("div", { class: "event-detail" });
  detail.hidden = true;
  const cls = statusClass(e);
  const row = h(
    "button",
    {
      class: "event-row",
      "aria-expanded": "false",
      onclick: async () => {
        const open = detail.hidden;
        detail.hidden = !open;
        row.setAttribute("aria-expanded", String(open));
        if (open && !detail.dataset.loaded) {
          detail.dataset.loaded = "1";
          detail.append(h("p", { class: "muted", text: "読み込み中…" }));
          try {
            renderEventDetail(detail, await api(siteApi(`/events/${e.id}`)));
          } catch (err) {
            detail.replaceChildren(h("div", { class: "notice", text: err.message }));
          }
        }
      },
    },
    h("span", { class: "time mono", text: fmtDate(e.ts) }),
    h("span", { class: `code-badge ${cls}`, text: e.outcome === "ok" ? String(e.status) : `${e.status} ${OUTCOME[e.outcome]}` }),
    h("span", { class: "method mono", text: e.method }),
    h("span", { class: "path mono", title: e.path, text: e.path }),
    h("span", { class: "num", text: fmtMs(e.durationMs) }),
    h("span", { class: "num logs", text: e.logCount ? String(e.logCount) : "–" }),
  );
  wrap.append(row, detail);
  return wrap;
}

function renderEventDetail(el, e) {
  const d = e.detail;
  const kv = (obj) => h("dl", { class: "kv" }, ...Object.entries(obj).flatMap(([k, v]) => [h("dt", { class: "mono", text: k }), h("dd", { class: "mono", text: v })]));
  fill(
    el,
    h("h3", { text: "概要" }),
    kv({
      時刻: fmtDate(e.ts),
      種類: e.kind === "worker" ? "Worker" : "アセット",
      結果: `${OUTCOME[e.outcome]}（${e.status}）`,
      実行時間: fmtMs(e.durationMs),
      URL: d.url,
      ...(e.release ? { リリース: e.release } : {}),
    }),
    d.exceptions.length ? h("h3", { text: "例外" }) : null,
    ...d.exceptions.map((x) => h("pre", { class: "log", text: x.stack || `${x.name}: ${x.message}` })),
    h("h3", { text: `ログ（${d.logs.length + d.droppedLogs}）` }),
    d.logs.length
      ? h(
          "div",
          { class: "mono" },
          ...d.logs.map((l) => h("div", { class: "logline" }, h("span", { class: "ts muted", text: fmtTime(l.ts) }), h("span", { class: `level lv-${l.level}`, text: l.level }), h("span", { class: "msg", text: l.message }))),
          d.droppedLogs ? h("div", { class: "muted", text: `ほか ${d.droppedLogs} 件は省略しました` }) : null,
        )
      : h("p", { class: "muted", text: "console 出力はありません" }),
    d.subrequests.length ? h("h3", { text: `サブリクエスト（${d.subrequests.length}）` }) : null,
    d.subrequests.length
      ? h(
          "table",
          { class: "mono" },
          h("tbody", {}, ...d.subrequests.map((s) => h("tr", {}, h("td", { text: s.method }), h("td", { class: "path", text: s.url }), h("td", { text: s.status ?? s.error ?? "" }), h("td", { class: "num", text: fmtMs(s.durationMs) })))),
        )
      : null,
    h("h3", { text: "リクエストヘッダ" }),
    kv(d.request),
    Object.keys(d.response).length ? h("h3", { text: "レスポンスヘッダ" }) : null,
    Object.keys(d.response).length ? kv(d.response) : null,
  );
}

// ---------- 設定 ----------

/** GitHub Actions のワークフロー。デプロイ先は site（管理画面で追加したサイト）で決まる（wrangler の name は使わない） */
const workflow = (url, site) => `name: Deploy to Kanzume
on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: kazukingzz/Kanzume/action@main
        with:
          url: "${url}"
          site: "${site}"
          token: \${{ secrets.KANZUME_TOKEN }}
`;

function copyButton(get) {
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

function armed(button, label, confirmLabel, action) {
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

function passkeyList() {
  const list = h("ul", { class: "passkeys" }, h("li", { class: "muted", text: "読み込み中…" }));
  const render = (passkeys) => {
    fill(list, ...passkeys.map((p, i) => passkeyItem(p, i, () => load(), passkeys.length > 1)));
  };
  const load = () =>
    api("/passkeys")
      .then(({ passkeys }) => render(passkeys))
      .catch((err) => fill(list, h("li", { class: "error", text: err.message })));
  load();
  list.reload = load;
  return list;
}

function passkeyItem(p, i, reload, removable) {
  const label = p.name || `パスキー ${i + 1}`;
  const meta = [
    p.provider && p.provider !== p.name ? p.provider : null,
    p.device && p.device !== p.name ? `${p.device} で登録` : null,
    `登録 ${fmtDate(p.createdAt).slice(0, 10)}`,
    p.lastUsedAt ? `最終使用 ${fmtAgo(p.lastUsedAt)}` : "未使用",
  ].filter(Boolean);
  const item = h("li", { class: "passkey" });
  const show = () => {
    const rename = h("button", { class: "ghost", text: "名前を変更", onclick: edit });
    const error = h("div", { class: "error" });
    // 最後の 1 つは消せない（サインインできなくなるため）
    const remove = removable
      ? armed(h("button", { class: "ghost danger" }), "削除", "もう一度押すと削除", async () => {
          try {
            await api(`/passkeys/${encodeURIComponent(p.id)}`, { method: "DELETE" });
            reload();
          } catch (err) {
            error.textContent = err.message;
          }
        })
      : null;
    fill(item, h("div", { class: "grow" }, h("div", { class: "passkey-name", text: label }), h("div", { class: "muted passkey-meta", text: meta.join(" · ") }), error), rename, remove);
  };
  function edit() {
    const input = h("input", { value: p.name, maxlength: "40", placeholder: label, "aria-label": "パスキーの名前" });
    const error = h("div", { class: "error" });
    const save = async () => {
      try {
        await api("/passkeys/rename", { method: "POST", body: JSON.stringify({ id: p.id, name: input.value }) });
        reload();
      } catch (err) {
        error.textContent = err.message;
      }
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) save();
      if (e.key === "Escape") show();
    });
    fill(item, h("div", { class: "grow" }, h("div", { class: "row" }, input, h("button", { class: "primary", text: "保存", onclick: save }), h("button", { text: "キャンセル", onclick: show })), error));
    input.focus();
    input.select();
  }
  show();
  return item;
}

function domainCard() {
  const d = state.overview.domain;
  const input = h("input", { value: d.value ?? "", placeholder: "example.com", spellcheck: "false", autocomplete: "off", "aria-label": "ルートドメイン", disabled: d.fromEnv || undefined });
  const error = h("div", { class: "error" });
  const save = h("button", { class: "primary", text: "保存", disabled: d.fromEnv || undefined });
  const run = async () => {
    if (save.disabled) return;
    error.textContent = "";
    save.disabled = true;
    try {
      await api("/domain", { method: "POST", body: JSON.stringify({ domain: input.value }) });
      // サイトの URL が新しいドメインになるので読み直す
      await loadOverview();
      route();
    } catch (err) {
      error.textContent = err.message;
      save.disabled = false;
    }
  };
  save.addEventListener("click", run);
  input.addEventListener("keydown", (e) => e.key === "Enter" && !e.isComposing && run());
  const now = d.value || d.fromEnv ? d.effective : null;
  return h(
    "section",
    { class: "card" },
    h("h2", { text: "ドメイン" }),
    h("p", {
      class: "muted",
      text: "サイトは <サイト名>.<ドメイン>、ルートのサイトは <ドメイン> で配信します。DNS はドメイン本体とワイルドカード（*.<ドメイン>）を Kanzume に向けてください。空にすると、管理画面を開いたホストをドメインとして使います。",
    }),
    h("div", { class: "field" }, h("label", { text: "ルートドメイン" }), h("div", { class: "row" }, h("div", { class: "grow" }, input), save)),
    d.fromEnv ? h("p", { class: "muted hint", text: `環境変数 KANZUME_ORIGIN で ${d.effective} に決まっています。変えるには環境変数を変更してください。` }) : null,
    !d.fromEnv && !d.value ? h("p", { class: "muted hint", text: `今は自動です（この画面を開いている ${d.current} をドメインとして使っています）。` }) : null,
    now && now !== d.current ? h("p", { class: "muted hint", text: `この管理画面は ${d.current} で開いています。サイトは ${now} とそのサブドメインで配信されます。` }) : null,
    error,
  );
}

function backupCard() {
  const body = h("div", {}, h("p", { class: "muted", text: "読み込み中…" }));
  const error = h("div", { class: "error" });
  const run = (b) => {
    const at = (x) => (x?.at ? `${fmtDate(x.at)}（${fmtAgo(x.at)}）` : "–");
    const last = b.lastBackup;
    const lastText = !last
      ? "この起動ではまだバックアップしていません"
      : !last.ok
        ? `失敗: ${last.error}`
        : last.skipped
          ? last.skipped
          : `世代 ${last.snapshot} を保存（${last.files} ファイル、送信 ${last.uploadedFiles} 件・${fmtBytes(last.uploadedBytes ?? 0)}）`;
    const restore = b.lastRestore;
    const restoreText = !restore ? "起動時に復元していません（/data にデータがあったか、バックアップがありませんでした）" : restore.ok ? `世代 ${restore.snapshot} を復元しました（${restore.files} ファイル）` : `失敗: ${restore.error}`;
    const button = h("button", { class: "primary", text: "今すぐバックアップ" });
    button.addEventListener("click", async () => {
      error.textContent = "";
      busy(button, "バックアップ中…");
      try {
        run(await api("/backup/run", { method: "POST", body: "{}" }));
      } catch (err) {
        error.textContent = err.message;
        load();
      }
    });
    fill(
      body,
      h(
        "dl",
        { class: "kv" },
        h("dt", { text: "保存先" }),
        h("dd", { class: "mono", text: b.target }),
        h("dt", { text: "最新の世代" }),
        h("dd", { text: b.latest ? `${b.latest}（全 ${b.snapshots} 世代・最大 ${b.keep}）` : b.snapshots === 0 ? "まだありません" : "–" }),
        h("dt", { text: "最後の実行" }),
        h("dd", {}, h("div", { text: at(last) }), h("div", { class: last && !last.ok ? "error" : "muted", text: lastText })),
        h("dt", { text: "起動時の復元" }),
        h("dd", {}, restore ? h("div", { text: at(restore) }) : null, h("div", { class: restore && !restore.ok ? "error" : "muted", text: restoreText })),
        h("dt", { text: "定期実行" }),
        h("dd", { text: `${b.intervalMinutes} 分ごと（ほかにデプロイや設定の変更のあと）` }),
      ),
      h("div", { class: "actions" }, button),
    );
  };
  const load = async () => {
    try {
      const b = await api("/backup");
      if (b.enabled) return run(b);
      fill(
        body,
        h("p", { class: "muted", text: "バックアップは無効です。環境変数 KANZUME_BACKUP_URL に S3 互換ストレージ（Cloudflare R2 など）を指定すると、データを外部に保存し、/data が空の状態で起動したときに自動で復元します。" }),
        h("code", { class: "value", text: "s3://<ACCESS_KEY_ID>:<SECRET_ACCESS_KEY>@<ACCOUNT_ID>.r2.cloudflarestorage.com/<BUCKET>" }),
      );
    } catch (err) {
      error.textContent = err.message;
    }
  };
  load();
  return h("section", { class: "card" }, h("h2", { text: "バックアップ" }), body, error);
}

// ---------- 設定（個人） ----------

async function viewSettings(main) {
  const me = state.overview.me;
  const nameInput = h("input", { value: me.name, maxlength: "40", autocomplete: "name", "aria-label": "名前" });
  const nameError = h("div", { class: "error" });
  const nameSave = h("button", { class: "primary", text: "保存" });
  const saveName = async () => {
    nameError.textContent = "";
    nameSave.disabled = true;
    try {
      const { name } = await api("/me", { method: "PUT", body: JSON.stringify({ name: nameInput.value }) });
      me.name = name;
      nameSave.textContent = "保存しました";
      setTimeout(() => (nameSave.textContent = "保存"), 1500);
    } catch (err) {
      nameError.textContent = err.message;
    } finally {
      nameSave.disabled = false;
    }
  };
  nameSave.addEventListener("click", saveName);
  nameInput.addEventListener("keydown", (e) => e.key === "Enter" && !e.isComposing && saveName());

  const addError = h("div", { class: "error" });
  const list = passkeyList();
  const addPasskey = h("button", { text: "＋ このデバイスのパスキーを追加" });
  addPasskey.addEventListener("click", async () => {
    addError.textContent = "";
    try {
      await registerPasskey();
      list.reload();
    } catch (err) {
      addError.textContent = err.message;
    }
  });

  const mySites = isAdmin()
    ? h("p", { class: "muted", text: "管理者なので、すべてのサイトを扱えます。" })
    : me.sites.length
      ? h("ul", { class: "secrets" }, ...me.sites.map((name) => h("li", { class: "secret" }, h("a", { class: "grow", href: siteHash("deployments", name), text: name }), h("span", { class: "muted", text: "メンバー" }))))
      : h("p", { class: "muted", text: "参加しているサイトはありません。管理者から招待リンクをもらって開いてください。" });

  main.replaceChildren(
    h(
      "div",
      { class: "page" },
      pageHead("設定"),
      h(
        "section",
        { class: "card" },
        h("h2", { text: "プロフィール" }),
        h("div", { class: "field" }, h("label", { text: "名前" }), h("div", { class: "row narrow" }, h("div", { class: "grow" }, nameInput), nameSave)),
        h("p", { class: "muted hint", text: `ロール: ${isAdmin() ? "管理者" : "メンバー"}` }),
        nameError,
      ),
      h("section", { class: "card" }, h("h2", { text: "参加しているサイト" }), mySites),
      personalTokensCard(),
      h("section", { class: "card" }, h("h2", { text: "パスキー" }), h("p", { class: "muted", text: "別のデバイスからもサインインできるように、パスキーを追加できます。" }), list, h("div", { class: "actions" }, addPasskey), addError),
    ),
  );
}

/** ルートドメイン（サブドメインなし）で配信するサイトを選ぶ。管理画面と同じオリジンで動くので、管理者だけが決める */
function rootSiteCard() {
  const error = h("div", { class: "error" });
  const deployed = state.sites.sites.filter((x) => x.deployed);
  const select = h(
    "select",
    { class: "wide", "aria-label": "ルートドメインで配信するサイト" },
    h("option", { value: "", text: "配信しない" }),
    ...deployed.map((x) => h("option", { value: x.name, text: x.name })),
  );
  select.value = state.sites.root ?? "";
  const save = h("button", { class: "primary", text: "保存" });
  save.addEventListener("click", async () => {
    error.textContent = "";
    save.disabled = true;
    try {
      await api("/root-site", { method: "POST", body: JSON.stringify({ name: select.value || null }) });
      await loadOverview();
      route();
    } catch (err) {
      error.textContent = err.message;
      save.disabled = false;
    }
  });
  const host = state.overview.domain?.effective ?? location.host;
  return h(
    "section",
    { class: "card" },
    h("h2", { text: "ルートドメインのサイト" }),
    h("p", {
      class: "muted",
      text: `${host} （サブドメインなし）で配信するサイトを 1 つ選べます。ルートのサイトは管理画面と同じオリジンで動くので、そのサイトにデプロイできる人は管理者と同等になります。選べるのはデプロイ済みのサイトだけです。`,
    }),
    h("div", { class: "row narrow" }, h("div", { class: "grow" }, select), save),
    error,
  );
}

/** 個人トークン（git push のパスワードと、GitHub Actions の KANZUME_TOKEN に使う） */
function personalTokensCard() {
  const list = h("div", { class: "list token-list" });
  const issued = h("div");
  const error = h("div", { class: "error" });
  const render = (tokens) => {
    fill(
      list,
      ...tokens.map((t) =>
        h(
          "div",
          { class: "list-item" },
          h(
            "div",
            { class: "list-row static" },
            h("span", { class: "status neutral", text: t.expiresAt ? "期限付き" : "無期限" }),
            h("div", { class: "grow" }, h("div", { class: "title", text: t.name }), h("div", { class: "sub", text: `発行 ${fmtDate(t.createdAt)} · ${t.expiresAt ? `期限 ${fmtDate(t.expiresAt)}` : "無期限"}` })),
            armed(h("button", { class: "danger" }), "取り消す", "もう一度押すと取り消す", async () => {
              try {
                await api(`/tokens/${t.id}`, { method: "DELETE" });
                load();
              } catch (err) {
                error.textContent = err.message;
              }
            }),
          ),
        ),
      ),
    );
    if (!tokens.length) list.append(h("div", { class: "empty", text: "発行したトークンはありません" }));
  };
  const load = () =>
    api("/tokens")
      .then(({ tokens }) => render(tokens))
      .catch((err) => (error.textContent = err.message));
  const name = h("input", { placeholder: "例: ノート PC・GitHub Actions", maxlength: "40", "aria-label": "トークンの名前" });
  const ttl = h("select", { "aria-label": "期限" }, ...TTL_OPTIONS.map(([v, label]) => h("option", { value: v, text: label })));
  ttl.value = "2592000";
  const issue = h("button", { class: "primary", text: "発行" });
  issue.addEventListener("click", async () => {
    error.textContent = "";
    issue.disabled = true;
    try {
      const t = await api("/tokens", { method: "POST", body: JSON.stringify({ name: name.value, ttl: ttl.value ? Number(ttl.value) : null }) });
      name.value = "";
      fill(
        issued,
        h(
          "div",
          { class: "notice good-notice" },
          h("b", { text: "トークンを発行しました。この画面を離れると二度と表示できません。" }),
          h("div", { class: "row" }, h("code", { class: "value grow", text: t.token }), copyButton(() => t.token)),
        ),
      );
      load();
    } catch (err) {
      error.textContent = err.message;
    } finally {
      issue.disabled = false;
    }
  });
  load();
  const scope = isAdmin() ? "すべてのサイト" : "参加しているサイト";
  return h(
    "section",
    { class: "card" },
    h("h2", { text: "トークン" }),
    h("p", {
      class: "muted",
      text: `${scope}のリポジトリへの git push（パスワードに入力）と、GitHub Actions からのデプロイ（Secrets の KANZUME_TOKEN）に使える、あなた個人のトークンです。使う場所ごとに名前を付けて発行し、いらなくなったら取り消してください。`,
    }),
    h(
      "div",
      { class: "token-form" },
      h("label", { class: "token-field grow" }, h("span", { text: "名前" }), name),
      h("label", { class: "token-field" }, h("span", { text: "期限" }), ttl),
      issue,
    ),
    error,
    issued,
    list,
  );
}

/** 管理者設定のメンバー一覧（ロールの変更・サイトから外す・削除） */
function usersCard() {
  const body = h("div", {}, h("p", { class: "muted", text: "読み込み中…" }));
  const error = h("div", { class: "error" });
  const act = (fn) => async () => {
    error.textContent = "";
    try {
      await fn();
      await loadOverview();
      load();
    } catch (err) {
      error.textContent = err.message;
    }
  };
  const load = async () => {
    try {
      const { users } = await api("/users");
      fill(
        body,
        h(
          "ul",
          { class: "users" },
          ...users.map((u) => {
            const role = h("select", { "aria-label": `${u.name} のロール` }, h("option", { value: "admin", text: "管理者", selected: u.role === "admin" }), h("option", { value: "member", text: "メンバー", selected: u.role === "member" }));
            role.addEventListener("change", act(() => api(`/users/${encodeURIComponent(u.id)}`, { method: "PUT", body: JSON.stringify({ role: role.value }) })));
            const sitesView =
              u.role === "admin"
                ? h("span", { class: "muted", text: "すべてのサイト" })
                : u.sites.length
                  ? h(
                      "span",
                      { class: "tags" },
                      ...u.sites.map((name) =>
                        h(
                          "span",
                          { class: "tag" },
                          name,
                          h("button", { class: "tag-remove", title: `${name} から外す`, "aria-label": `${u.name} を ${name} から外す`, text: "×", onclick: act(() => api(`/users/${encodeURIComponent(u.id)}`, { method: "PUT", body: JSON.stringify({ removeSite: name }) })) }),
                        ),
                      ),
                    )
                  : h("span", { class: "muted", text: "参加しているサイトなし" });
            // メンバーに扱えるサイトを足す（招待リンクを使わずに）
            const addable = state.sites.sites.map((x) => x.name).filter((n) => !u.sites.includes(n));
            const attach =
              u.role === "member" && addable.length
                ? (() => {
                    const pick = h("select", { "aria-label": `${u.name} に足すサイト` }, h("option", { value: "", text: "サイトを足す…" }), ...addable.map((n) => h("option", { value: n, text: n })));
                    pick.addEventListener("change", () => pick.value && act(() => api(`/users/${encodeURIComponent(u.id)}`, { method: "PUT", body: JSON.stringify({ addSite: pick.value }) }))());
                    return pick;
                  })()
                : null;
            return h(
              "li",
              { class: "user" },
              h(
                "div",
                { class: "grow" },
                h("div", { class: "user-name" }, h("b", { text: u.name }), u.me ? h("span", { class: "tag", text: "自分" }) : null),
                h("div", { class: "muted user-meta" }, `パスキー ${u.passkeys} 個 · ${u.lastUsedAt ? `最終利用 ${fmtAgo(u.lastUsedAt)}` : "未使用"}`),
                h("div", { class: "user-sites" }, sitesView, attach),
              ),
              u.me ? null : role,
              u.me ? null : armed(h("button", { class: "danger" }), "削除", "もう一度押すと削除", act(() => api(`/users/${encodeURIComponent(u.id)}`, { method: "DELETE" }))),
            );
          }),
        ),
      );
    } catch (err) {
      error.textContent = err.message;
    }
  };
  load();
  return h(
    "section",
    { class: "card" },
    h("h2", { text: "メンバー" }),
    h("p", { class: "muted", text: "メンバーは参加しているサイトだけを扱えます。扱えるサイトは「サイトを足す…」と × で変えられます。新しい人は、各サイトの「サイト設定 > メンバー」で作る招待リンクから参加します。ロールを管理者にすると、全体の設定とすべてのサイトを扱えるようになります。削除するとそのユーザーのパスキーも消えます。" }),
    body,
    error,
  );
}

// ---------- 管理者設定 ----------

async function viewAdmin(main) {
  main.replaceChildren(h("div", { class: "page" }, pageHead("管理者設定"), domainCard(), rootSiteCard(), backupCard(), usersCard()));
}

// ---------- サイト設定 ----------

async function viewSite(main) {
  const detail = await loadSite();
  const r = detail.release;
  const page = h("div", { class: "page" }, pageHead("サイト設定"));
  if (r) page.append(kindBanner(releaseKind(r)));
  const rows = !r
    ? [
        ["名前", detail.name],
        ["URL", h("span", {}, detail.subdomainUrl, h("span", { class: "muted", text: "（まだデプロイしていないので配信していません）" }))],
      ]
    : [
    ["名前", r.name],
    ["URL", siteUrlCell(detail)],
    ["種類", h("span", {}, kindBadge(releaseKind(r)), " ", KIND[releaseKind(r)].title)],
    ["Worker", r.main ? `worker/${r.main}` : "なし"],
    ["compatibility_date", r.compatibilityDate ?? "–"],
    ["compatibility_flags", r.compatibilityFlags.length ? r.compatibilityFlags.join(", ") : "–"],
    ["KV", r.kv.length ? r.kv.join(", ") : "–"],
    ["R2", r.r2.length ? r.r2.map((b) => `${b.binding}（${b.bucket}）`).join(", ") : "–"],
    ["Assets", r.assets ? [`binding: ${r.assets.binding ?? "–"}`, `html_handling: ${r.assets.htmlHandling}`, `not_found_handling: ${r.assets.notFoundHandling}`, `run_worker_first: ${JSON.stringify(r.assets.runWorkerFirst)}`].join(" / ") : "–"],
  ];
  const settings = await api(siteApi("/settings"));


  const delError = h("div", { class: "error" });
  // 権限や未デプロイで出さないカードは null になるので、DOM の append（null を文字として足す）ではなく fill を使う
  fill(
    page,
    ...page.childNodes,
    h(
      "section",
      { class: "card" },
      h("h2", { text: "サイト" }),
      h("dl", { class: "kv" }, ...rows.flatMap(([k, v]) => [h("dt", { text: k }), h("dd", {}, v)])),
    ),
    ...siteSettingsCards(settings),
    isAdmin() ? siteMembersCard() : null,
    h(
      "section",
      { class: "card" },
      h("h2", { text: "サイトの削除" }),
      h("p", { class: "muted", text: "公開を止め、このサイトの KV / R2 のデータ・デプロイ履歴・ログと、同じ名前のリポジトリをすべて削除します。ほかのサイトとメンバーのパスキーは残ります。" }),
      armed(h("button", { class: "danger" }), "サイトを削除", "もう一度押すと削除", async () => {
        try {
          await api(siteApi(), { method: "DELETE" });
          state.siteName = null;
          await loadOverview();
          const next = state.sites.root ?? state.sites.sites[0]?.name;
          go(next ? siteHash("deployments", next) : isAdmin() ? "#/new" : "#/settings");
        } catch (err) {
          delError.textContent = err.message;
        }
      }),
      delError,
    ),
  );
  main.replaceChildren(page);
}

/** サイトのメンバーと招待リンク（管理者だけ） */
function siteMembersCard() {
  const body = h("div", {}, h("p", { class: "muted", text: "読み込み中…" }));
  const issued = h("div");
  const error = h("div", { class: "error" });
  const site = state.siteName;
  const load = async () => {
    try {
      const { members, invites } = await api(siteApi("/members"));
      fill(
        body,
        h("div", { class: "log-title", text: "メンバー" }),
        members.length
          ? h(
              "ul",
              { class: "secrets" },
              ...members.map((m) =>
                h(
                  "li",
                  { class: "secret" },
                  h("span", { class: "grow", text: m.name }),
                  h("span", { class: "muted", text: `参加 ${fmtDate(m.createdAt).slice(0, 10)}` }),
                  armed(h("button", { class: "danger" }), "外す", "もう一度押すと外す", async () => {
                    try {
                      await api(siteApi(`/members/${encodeURIComponent(m.id)}`), { method: "DELETE" });
                      load();
                    } catch (err) {
                      error.textContent = err.message;
                    }
                  }),
                ),
              ),
            )
          : h("p", { class: "muted", text: "まだいません。招待リンクを作って渡してください。" }),
        invites.length ? h("div", { class: "log-title", text: "未使用の招待リンク" }) : null,
        invites.length
          ? h(
              "ul",
              { class: "secrets" },
              ...invites.map((i) =>
                h(
                  "li",
                  { class: "secret" },
                  h("span", { class: "grow muted", text: `${fmtDate(i.createdAt)} に${i.createdBy ? ` ${i.createdBy} が` : ""}作成 · ${fmtDate(i.expiresAt).slice(0, 10)} まで` }),
                  armed(h("button", { class: "danger" }), "取り消す", "もう一度押すと取り消す", async () => {
                    try {
                      await api(siteApi(`/invites/${i.id}`), { method: "DELETE" });
                      load();
                    } catch (err) {
                      error.textContent = err.message;
                    }
                  }),
                ),
              ),
            )
          : null,
      );
    } catch (err) {
      error.textContent = err.message;
    }
  };
  const create = h("button", { class: "primary", text: "招待リンクを作る" });
  create.addEventListener("click", async () => {
    error.textContent = "";
    create.disabled = true;
    try {
      const invite = await api(siteApi("/invites"), { method: "POST", body: "{}" });
      fill(
        issued,
        h(
          "div",
          { class: "notice good-notice" },
          h("b", { text: `招待リンクを作りました。1 人が 1 回だけ使え、${invite.ttlDays} 日で無効になります。この画面を離れると二度と表示できません。` }),
          h("div", { class: "row" }, h("code", { class: "value grow", text: invite.url }), copyButton(() => invite.url)),
        ),
      );
      load();
    } catch (err) {
      error.textContent = err.message;
    } finally {
      create.disabled = false;
    }
  });
  load();
  return h(
    "section",
    { class: "card" },
    h("h2", { text: "メンバー" }),
    h("p", { class: "muted", text: `招待リンクを開いた人がパスキーを登録すると、${site} のメンバーになります。メンバーはこのサイトのデプロイ・設定・削除と、同じ名前のリポジトリを扱えます。ほかのサイトや管理者設定は見えません。` }),
    h("div", { class: "actions" }, create),
    issued,
    body,
    error,
  );
}

/** サイト設定のサブドメイン・環境変数・シークレット。保存するとすぐ（次のリクエストから）反映される */
function siteSettingsCards(settings) {
  const reload = async () => {
    await loadOverview().catch(() => {});
    route();
  };
  const saveWith = (button, error, done, getBody) => async () => {
    error.textContent = "";
    done.textContent = "";
    let body;
    try {
      body = getBody();
    } catch (err) {
      error.textContent = err.message;
      return;
    }
    button.disabled = true;
    try {
      await api(siteApi("/settings"), { method: "PUT", body: JSON.stringify(body) });
      done.textContent = "保存しました。次のリクエストから反映されます。";
      return true;
    } catch (err) {
      error.textContent = err.message;
    } finally {
      button.disabled = false;
    }
  };

  // サブドメイン
  const sub = subdomainInput(settings.subdomain, "サブドメイン");
  const subError = h("div", { class: "error" });
  const subDone = h("p", { class: "muted hint" });
  const subSave = h("button", { class: "primary", text: "保存" });
  const saveSub = saveWith(subSave, subError, subDone, () => ({ subdomain: sub.input.value.trim() }));
  subSave.addEventListener("click", async () => (await saveSub()) && reload());
  sub.input.addEventListener("keydown", async (e) => e.key === "Enter" && !e.isComposing && (await saveSub()) && reload());

  // 環境変数
  const wrangler = settings.wranglerVars ?? {};
  const varsBox = h("div");
  const vars = envEditor(settings.vars);
  const renderWrangler = () => {
    let current = {};
    try {
      current = vars.values();
    } catch {}
    fill(varsBox, wranglerVarsView(wrangler, (k) => Object.hasOwn(current, k)));
  };
  renderWrangler();
  vars.el.addEventListener("input", renderWrangler);
  vars.el.addEventListener("click", () => setTimeout(renderWrangler));
  const varsError = h("div", { class: "error" });
  const varsDone = h("p", { class: "muted hint" });
  const varsSave = h("button", { class: "primary", text: "保存" });
  varsSave.addEventListener("click", saveWith(varsSave, varsError, varsDone, () => ({ vars: vars.values() })));

  // シークレット
  const secretError = h("div", { class: "error" });
  const secretDone = h("p", { class: "muted hint" });
  const putSecrets = async (secrets) => {
    secretError.textContent = "";
    try {
      await api(siteApi("/settings"), { method: "PUT", body: JSON.stringify({ secrets }) });
      route();
    } catch (err) {
      secretError.textContent = err.message;
    }
  };
  const secretItem = (key) => {
    const item = h("li", { class: "secret" });
    const show = () =>
      fill(
        item,
        h("code", { class: "grow", text: key }),
        h("span", { class: "muted", text: "設定済み" }),
        h("button", {
          text: "値を変更",
          onclick: () => {
            const input = h("input", { class: "mono", type: "password", placeholder: "新しい値", autocomplete: "new-password", "aria-label": `${key} の新しい値` });
            const ok = h("button", { class: "primary", text: "保存", onclick: () => putSecrets({ [key]: input.value }) });
            input.addEventListener("keydown", (e) => e.key === "Enter" && !e.isComposing && ok.click());
            fill(item, h("code", { text: key }), h("div", { class: "grow" }, input), ok, h("button", { text: "キャンセル", onclick: show }));
            input.focus();
          },
        }),
        armed(h("button", { class: "danger" }), "削除", "もう一度押すと削除", () => putSecrets({ [key]: null })),
      );
    show();
    return item;
  };
  const newSecrets = envEditor({}, { masked: true });
  const secretSave = h("button", { class: "primary", text: "追加" });
  secretSave.addEventListener("click", async () => {
    let values;
    try {
      values = newSecrets.values();
    } catch (err) {
      secretError.textContent = err.message;
      return;
    }
    if (!Object.keys(values).length) {
      secretError.textContent = "名前と値を入力してください";
      return;
    }
    const dup = Object.keys(values).find((k) => settings.secretKeys.includes(k));
    if (dup && !confirm(`シークレット ${dup} は既にあります。値を上書きしますか？`)) return;
    await putSecrets(values);
  });
  // 追加用の空の行を 1 つ出しておく
  newSecrets.add();

  return [
    h(
      "section",
      { class: "card" },
      h("h2", { text: "サブドメイン" }),
      h("p", { class: "muted", text: `変えると前のサブドメインでは配信しなくなります。サイトの ID（${state.siteName}）と、git push・GitHub Actions で使う name は変わりません。` }),
      h("div", { class: "row narrow" }, h("div", { class: "grow" }, sub.el), subSave),
      subError,
      subDone,
    ),
    h(
      "section",
      { class: "card" },
      h("h2", { text: "環境変数" }),
      h("p", { class: "muted", text: "Worker の env（nodejs_compat なら process.env も）に入ります。wrangler の設定の vars と同じ名前なら、こちらが優先されます。再デプロイしなくても、保存した次のリクエストから反映されます。" }),
      vars.el,
      varsBox,
      h("div", { class: "actions" }, varsSave),
      varsError,
      varsDone,
    ),
    h(
      "section",
      { class: "card" },
      h("h2", { text: "シークレット" }),
      h("p", { class: "muted", text: "API キーなど。env に入りますが、保存したあとは値を表示しません。" }),
      settings.secretKeys.length ? h("ul", { class: "secrets" }, ...settings.secretKeys.map(secretItem)) : h("p", { class: "muted", text: "まだありません。" }),
      h("div", { class: "log-title", text: "追加" }),
      newSecrets.el,
      h("div", { class: "actions" }, secretSave),
      secretError,
      secretDone,
    ),
  ];
}

// ---------- データベース（KV）・ストレージ（R2） ----------

const ICONS = {
  database: '<svg viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></svg>',
  storage: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7l9-4 9 4-9 4-9-4z"/><path d="M3 12l9 4 9-4M3 17l9 4 9-4"/></svg>',
  folder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  file: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></svg>',
};
const icon = (name, cls = "icon") => h("span", { class: cls, html: ICONS[name] });

/** 何もないときの表示。wrangler の設定の例を添える */
function emptyState(iconName, title, text, snippet) {
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
function chooser(items, current, onChange, label) {
  if (items.length <= 1) return null;
  const select = h("select", { "aria-label": label }, ...items.map((x) => h("option", { value: x.name, text: x.label ?? x.name })));
  select.value = current;
  select.addEventListener("change", () => onChange(select.value));
  return h("label", { class: "inline" }, label, select);
}

const fmtExpiration = (sec) => (sec ? `${fmtDate(sec * 1000)} に期限切れ` : "期限なし");
const prettyValue = (text) => {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
};

async function viewDatabase(main) {
  const site = state.siteName;
  const { namespaces } = await api(siteApi("/kv"));
  const page = h("div", { class: "page" }, pageHead("データベース"));
  if (!namespaces.length) {
    page.append(
      emptyState(
        "database",
        "KV はまだありません",
        "wrangler の設定に kv_namespaces を追加してデプロイすると、Worker が保存したキーと値をここで見たり編集したりできます。",
        `"kv_namespaces": [\n  { "binding": "KV", "id": "<任意の ID>" }\n]`,
      ),
    );
    return main.replaceChildren(page);
  }
  state.db ??= {};
  if (state.db.site !== site || !namespaces.some((n) => n.name === state.db.ns)) state.db = { site, ns: namespaces[0].name, prefix: "" };
  const ns = namespaces.find((n) => n.name === state.db.ns);
  const nsApi = (p) => siteApi(`/kv/${encodeURIComponent(ns.name)}${p}`);

  const list = h("div", { class: "list data-list" });
  const more = h("button", { class: "load-more", text: "さらに読み込む" });
  const error = h("div", { class: "error" });
  const search = h("input", { type: "search", placeholder: "キーの先頭で絞り込む", value: state.db.prefix, "aria-label": "キーの先頭" });
  let after = "";

  const row = (k) => {
    const item = h("div", { class: "list-item" });
    const detail = h("div", { class: "data-detail", hidden: true });
    const head = h(
      "button",
      { class: "list-row data-row", "aria-expanded": "false" },
      h("span", { class: "data-key mono", text: k.key }),
      h("span", { class: "muted", text: fmtBytes(k.size) }),
      h("span", { class: "muted data-exp", text: k.expiration ? fmtExpiration(k.expiration) : "" }),
    );
    const open = async () => {
      const value = await api(nsApi(`/value?key=${encodeURIComponent(k.key)}`));
      const edit = h("button", { text: "編集", onclick: () => fill(detail, editor({ key: k.key, value: value.text ?? "", metadata: value.metadata, expiration: value.expiration })) });
      const del = armed(h("button", { class: "danger" }), "削除", "もう一度押すと削除", async () => {
        try {
          await api(nsApi(`/value?key=${encodeURIComponent(k.key)}`), { method: "DELETE" });
          item.remove();
        } catch (err) {
          error.textContent = err.message;
        }
      });
      fill(
        detail,
        value.text === null
          ? h("p", { class: "muted", text: `バイナリの値です（${fmtBytes(value.size)}）。管理画面では表示・編集できません。` })
          : h("pre", { class: "log data-value", text: prettyValue(value.text) + (value.truncated ? "\n…（先頭の 256 KiB だけを表示しています）" : "") }),
        h(
          "dl",
          { class: "kv" },
          h("dt", { text: "サイズ" }),
          h("dd", { text: fmtBytes(value.size) }),
          h("dt", { text: "有効期限" }),
          h("dd", { text: fmtExpiration(value.expiration) }),
          h("dt", { text: "metadata" }),
          h("dd", { class: "mono", text: value.metadata === null ? "なし" : JSON.stringify(value.metadata) }),
        ),
        h("div", { class: "actions" }, value.text !== null && !value.truncated ? edit : null, del),
      );
    };
    head.addEventListener("click", async () => {
      const show = detail.hidden;
      detail.hidden = !show;
      head.setAttribute("aria-expanded", String(show));
      if (show) await open().catch((err) => fill(detail, h("div", { class: "error", text: err.message })));
    });
    item.append(head, detail);
    return item;
  };

  // 読み込みが重なったら、最後に始めたものの結果だけを使う（絞り込みの入力中や「さらに読み込む」の連打）
  let seq = 0;
  const load = async (reset) => {
    const mine = ++seq;
    more.disabled = true;
    const { keys, cursor } = await api(nsApi(`/keys?prefix=${encodeURIComponent(state.db.prefix)}&after=${encodeURIComponent(reset ? "" : after)}`)).finally(() => {
      if (mine === seq) more.disabled = false;
    });
    if (mine !== seq) return;
    if (reset) fill(list);
    for (const k of keys) list.append(row(k));
    if (reset && !keys.length) list.append(h("div", { class: "empty", text: state.db.prefix ? "このキーで始まるものはありません" : "まだキーがありません" }));
    after = cursor ?? "";
    more.hidden = !cursor;
  };
  more.addEventListener("click", () => load(false).catch((err) => (error.textContent = err.message)));
  let timer = null;
  search.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.db.prefix = search.value;
      load(true).catch((err) => (error.textContent = err.message));
    }, 250);
  });

  /** 追加・編集のフォーム（値は文字列。JSON もそのまま保存する） */
  const editor = (initial = null) => {
    const key = h("input", { class: "mono", value: initial?.key ?? "", placeholder: "キー", "aria-label": "キー", disabled: initial ? true : undefined });
    const value = h("textarea", { class: "mono", rows: "8", placeholder: "値（文字列・JSON）", "aria-label": "値" });
    value.value = initial?.value ?? "";
    const ttl = h("input", { type: "number", min: "60", placeholder: "なし", "aria-label": "有効期限（秒）" });
    // 編集では今の有効期限を残す（空のまま保存すると期限なしになるので、残り秒数を入れておく）
    if (initial?.expiration) ttl.value = String(Math.max(60, initial.expiration - Math.floor(Date.now() / 1000)));
    const formError = h("div", { class: "error" });
    const save = h("button", { class: "primary", text: "保存" });
    save.addEventListener("click", async () => {
      formError.textContent = "";
      save.disabled = true;
      try {
        await api(nsApi("/value"), { method: "PUT", body: JSON.stringify({ key: key.value, value: value.value, expirationTtl: ttl.value || null, metadata: initial?.metadata ?? null }) });
        addBox.hidden = true;
        await load(true);
      } catch (err) {
        formError.textContent = err.message;
      } finally {
        save.disabled = false;
      }
    });
    return h(
      "div",
      { class: "data-form" },
      h("div", { class: "field" }, h("label", { text: "キー" }), key),
      h("div", { class: "field" }, h("label", { text: "値" }), value),
      h("div", { class: "field narrow-field" }, h("label", { text: "有効期限（秒・60 以上。空なら期限なし）" }), ttl),
      h("div", { class: "actions" }, save),
      formError,
    );
  };
  const addBox = h("div", { class: "card add-box", hidden: true });
  const add = h("button", {
    text: "＋ キーを追加",
    onclick: () => {
      addBox.hidden = !addBox.hidden;
      if (!addBox.hidden) fill(addBox, h("h2", { text: "キーを追加" }), editor());
    },
  });

  page.append(
    h(
      "div",
      { class: "filters" },
      chooser(
        namespaces.map((n) => ({ name: n.name, label: `${n.name}${n.bound ? "" : "（設定にない）"}` })),
        ns.name,
        (name) => {
          state.db = { site, ns: name, prefix: "" };
          route();
        },
        "KV",
      ),
      search,
      add,
    ),
    h("p", { class: "muted data-summary", text: `名前空間（binding）${ns.name}・${ns.count} 件${ns.bound ? "" : "（今の wrangler の設定にはない名前空間です。データだけが残っています）"}` }),
    addBox,
    list,
    more,
    error,
  );
  main.replaceChildren(page);
  await load(true);
}

async function viewStorage(main) {
  const site = state.siteName;
  const { buckets } = await api(siteApi("/r2"));
  const page = h("div", { class: "page" }, pageHead("ストレージ"));
  if (!buckets.length) {
    page.append(
      emptyState(
        "storage",
        "R2 のバケットはまだありません",
        "wrangler の設定に r2_buckets を追加してデプロイすると、Worker が保存したファイル（オブジェクト）をここで見たり、アップロード・ダウンロードしたりできます。",
        `"r2_buckets": [\n  { "binding": "BUCKET", "bucket_name": "${site}" }\n]`,
      ),
    );
    return main.replaceChildren(page);
  }
  state.storage ??= {};
  if (state.storage.site !== site || !buckets.some((b) => b.name === state.storage.bucket)) state.storage = { site, bucket: buckets[0].name, prefix: "" };
  const bucket = buckets.find((b) => b.name === state.storage.bucket);
  const bApi = (p) => siteApi(`/r2/${encodeURIComponent(bucket.name)}${p}`);
  const go2 = (prefix) => {
    state.storage.prefix = prefix;
    route();
  };

  const error = h("div", { class: "error" });
  const list = h("div", { class: "list data-list" });
  const more = h("button", { class: "load-more", text: "さらに読み込む" });
  let cursor = null;

  // パンくず（フォルダは / 区切りのキーの先頭）
  const parts = state.storage.prefix.split("/").filter(Boolean);
  const crumbs = h(
    "nav",
    { class: "crumbs", "aria-label": "フォルダ" },
    h("button", { class: "ghost", text: bucket.name, onclick: () => go2("") }),
    ...parts.flatMap((p, i) => [h("span", { class: "muted", text: "/" }), h("button", { class: "ghost", text: p, onclick: () => go2(`${parts.slice(0, i + 1).join("/")}/`) })]),
  );

  const objectRow = (o) => {
    const item = h("div", { class: "list-item" });
    const name = o.key.slice(state.storage.prefix.length);
    const detail = h("div", { class: "data-detail", hidden: true });
    const head = h(
      "button",
      { class: "list-row data-row", "aria-expanded": "false" },
      h("span", { class: "data-key" }, icon("file"), h("span", { class: "mono", text: name })),
      h("span", { class: "muted", text: fmtBytes(o.size) }),
      h("span", { class: "muted data-exp", text: fmtDate(o.uploaded) }),
    );
    head.addEventListener("click", async () => {
      const show = detail.hidden;
      detail.hidden = !show;
      head.setAttribute("aria-expanded", String(show));
      if (!show) return;
      const download = h("a", { class: "button", href: `${BASE}/api${bApi(`/object?key=${encodeURIComponent(o.key)}`)}`, download: name, text: "ダウンロード" });
      const del = armed(h("button", { class: "danger" }), "削除", "もう一度押すと削除", async () => {
        try {
          await api(bApi(`/object?key=${encodeURIComponent(o.key)}`), { method: "DELETE" });
          item.remove();
        } catch (err) {
          error.textContent = err.message;
        }
      });
      const preview = h("div", {}, h("p", { class: "muted", text: "読み込み中…" }));
      fill(
        detail,
        preview,
        h(
          "dl",
          { class: "kv" },
          h("dt", { text: "キー" }),
          h("dd", { class: "mono", text: o.key }),
          h("dt", { text: "サイズ" }),
          h("dd", { text: fmtBytes(o.size) }),
          h("dt", { text: "Content-Type" }),
          h("dd", { text: o.contentType ?? "–" }),
          h("dt", { text: "アップロード" }),
          h("dd", { text: fmtDate(o.uploaded) }),
          h("dt", { text: "ETag" }),
          h("dd", { class: "mono", text: o.etag }),
          Object.keys(o.customMetadata).length ? h("dt", { text: "customMetadata" }) : null,
          Object.keys(o.customMetadata).length ? h("dd", { class: "mono", text: JSON.stringify(o.customMetadata) }) : null,
        ),
        h("div", { class: "actions" }, download, del),
      );
      try {
        const p = await api(bApi(`/preview?key=${encodeURIComponent(o.key)}`));
        fill(
          preview,
          p.text === null
            ? h("p", { class: "muted", text: "テキストではないのでプレビューできません。ダウンロードして開いてください。" })
            : h("pre", { class: "log data-value", text: prettyValue(p.text) + (p.truncated ? "\n…（先頭の 256 KiB だけを表示しています）" : "") }),
        );
      } catch (err) {
        fill(preview, h("div", { class: "error", text: err.message }));
      }
    });
    item.append(head, detail);
    return item;
  };

  let seq = 0;
  const load = async (reset) => {
    const mine = ++seq;
    more.disabled = true;
    const r = await api(bApi(`/objects?prefix=${encodeURIComponent(state.storage.prefix)}${!reset && cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)).finally(() => {
      if (mine === seq) more.disabled = false;
    });
    if (mine !== seq) return;
    if (reset) fill(list);
      // フォルダは 2 ページ目以降にも出てくる（キーの順に、オブジェクトと混ざって返る）
      for (const p of r.prefixes) {
        list.append(
          h(
            "div",
            { class: "list-item" },
            h("button", { class: "list-row data-row", onclick: () => go2(p) }, h("span", { class: "data-key" }, icon("folder"), h("span", { class: "mono", text: p.slice(state.storage.prefix.length) })), h("span"), h("span")),
          ),
        );
      }
    for (const o of r.objects) list.append(objectRow(o));
    if (reset && !r.objects.length && !r.prefixes.length) list.append(h("div", { class: "empty", text: "このフォルダにはまだ何もありません" }));
    cursor = r.cursor;
    more.hidden = !cursor;
  };
  more.addEventListener("click", () => load(false).catch((err) => (error.textContent = err.message)));

  // アップロード（今のフォルダに、ファイル名のキーで保存する）
  const fileInput = h("input", { type: "file", multiple: true, hidden: true });
  const upload = h("button", { text: "＋ アップロード", onclick: () => fileInput.click() });
  fileInput.addEventListener("change", async () => {
    error.textContent = "";
    // アップロード中に画面を移っても、選んだときのサイト・バケット・フォルダに送る
    const target = (key) => `${BASE}/api/sites/${encodeURIComponent(site)}/r2/${encodeURIComponent(bucket.name)}/object?key=${encodeURIComponent(key)}`;
    const prefix = state.storage.prefix;
    const failures = [];
    for (const file of [...fileInput.files]) {
      busy(upload, `アップロード中… ${file.name}`);
      try {
        const res = await fetch(target(prefix + file.name), {
          method: "PUT",
          body: file,
          headers: { "x-object-content-type": file.type || "application/octet-stream" },
          credentials: "same-origin",
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      } catch (err) {
        failures.push(`${file.name}: ${err.message}`);
      }
    }
    fileInput.value = "";
    upload.disabled = false;
    upload.textContent = "＋ アップロード";
    // 同じ画面にいるときだけ一覧を読み直す（エラーの表示は残す）
    if (page.isConnected) {
      error.textContent = failures.join(" / ");
      await load(true).catch((err) => (error.textContent = err.message));
    } else if (failures.length) {
      alert(`アップロードに失敗したファイルがあります\n${failures.join("\n")}`);
    }
  });

  page.append(
    h(
      "div",
      { class: "filters" },
      chooser(
        buckets.map((b) => ({ name: b.name, label: `${b.name}${b.binding ? `（${b.binding}）` : "（設定にない）"}` })),
        bucket.name,
        (name) => {
          state.storage = { site, bucket: name, prefix: "" };
          route();
        },
        "バケット",
      ),
      crumbs,
      h("span", { class: "spacer" }),
      upload,
      fileInput,
    ),
    h("p", { class: "muted data-summary", text: `バケット ${bucket.name}${bucket.binding ? `（binding: ${bucket.binding}）` : "（今の wrangler の設定にはないバケットです。データだけが残っています）"}・${bucket.count} 件・${fmtBytes(bucket.size)}` }),
    list,
    more,
    error,
  );
  main.replaceChildren(page);
  await load(true);
}

// ---------- リポジトリ ----------

const TTL_OPTIONS = [
  ["3600", "1 時間"],
  ["86400", "1 日"],
  ["2592000", "30 日"],
  ["", "無期限"],
];

async function viewRepo(main, name) {
  const repo = await api(`/repos/${encodeURIComponent(name)}`);
  const repoApi = (path) => `/repos/${encodeURIComponent(name)}${path}`;
  const page = h("div", { class: "page" });
  page.append(
    h(
      "div",
      { class: "page-head" },
      h("h1", { text: "リポジトリ" }),
    ),
  );

  const commands = `git remote add origin ${repo.cloneUrl}\ngit push -u origin ${repo.defaultBranch}`;
  page.append(
    h(
      "section",
      { class: "card" },
      h("h2", { text: "push してデプロイ" }),
      h("div", { class: "field" }, h("label", { text: "URL" }), h("div", { class: "row" }, h("code", { class: "value grow", text: repo.cloneUrl }), copyButton(() => repo.cloneUrl))),
      h("div", { class: "card-head" }, h("span", { class: "muted", text: "手元のリポジトリで" }), copyButton(() => commands)),
      h("pre", { class: "log", text: commands }),
      h("p", { class: "muted hint" }, "すでに origin がある（GitHub から clone した）リポジトリでは、1 行目の代わりに ", h("code", { text: `git remote set-url origin ${repo.cloneUrl}` }), " で付け替えるか、", h("code", { text: "origin" }), " を別の名前（例: ", h("code", { text: "kanzume" }), "）にしてください。"),
      h("p", { class: "muted hint" }, "ユーザー名は何でもよく、パスワードには「", h("a", { href: "#/settings", text: "設定 > トークン" }), `」で発行した個人トークンを入力します。${repo.defaultBranch} 以外のブランチへの push は保存だけしてデプロイしません。ブランチは削除できません。npm パッケージの import やビルドが必要なものは GitHub Actions を使ってください。`),
    ),
  );

  // 中身（ブランチ・コミット・ファイル）
  if (repo.refs.length) {
    const branch = h("select", { "aria-label": "ブランチ" }, ...repo.refs.map((r) => h("option", { value: r.branch, text: r.branch })));
    const remembered = state.repoRefs[name];
    const current = repo.refs.some((r) => r.branch === remembered) ? remembered : repo.defaultBranch;
    branch.value = repo.refs.some((r) => r.branch === current) ? current : repo.refs[0].branch;
    const commits = h("div", { class: "list repo-commits" });
    const tree = h("nav", { class: "tree" });
    const mobile = h("select", { class: "mobile-file", "aria-label": "ファイル" });
    const viewer = h("div", { class: "viewer" });
    let selected = null;
    const showRepoFile = async (path, buttons) => {
      selected = path;
      for (const b of buttons) b.classList.toggle("current", b.dataset.path === path);
      mobile.value = path;
      viewer.replaceChildren(h("div", { class: "viewer-head" }, h("span", { class: "path", text: path })), h("div", { class: "placeholder", text: "読み込み中…" }));
      const ref = branch.value;
      const file = await api(repoApi(`/blob?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}`)).catch((err) => ({ error: err.message }));
      // 待っている間に別のファイルやブランチに切り替わっていたら捨てる
      if (selected === path && branch.value === ref) renderFile(viewer, path, file);
    };
    let loading = 0;
    const load = async () => {
      state.repoRefs[name] = branch.value;
      const ticket = ++loading;
      const ref = encodeURIComponent(branch.value);
      const [{ commits: log }, { files }] = await Promise.all([api(repoApi(`/log?ref=${ref}`)), api(repoApi(`/tree?ref=${ref}`))]);
      // ブランチを続けて切り替えたとき、古い応答で上書きしない
      if (ticket !== loading) return;
      fill(
        commits,
        ...log.map((c) =>
          h(
            "div",
            { class: "list-item" },
            h("div", { class: "list-row static" }, h("span", { class: "mono sha", text: c.sha.slice(0, 7) }), h("div", { class: "grow" }, h("div", { class: "title", text: c.subject }), h("div", { class: "sub", text: `${c.author} · ${fmtDate(c.date)}` }))),
          ),
        ),
      );
      const buttons = [];
      const renderNode = (node, depth) => {
        const out = [];
        for (const [dir, child] of [...node.dirs].sort(([a], [b]) => a.localeCompare(b))) {
          const details = h("details", { open: depth < 1 || undefined });
          const summary = h("summary", { text: dir });
          summary.style.paddingLeft = `${14 + depth * 12}px`;
          details.append(summary, ...renderNode(child, depth + 1));
          out.push(details);
        }
        for (const f of node.files) {
          const b = h("button", { class: "file", title: f.path, "data-path": f.path, text: f.name, onclick: () => showRepoFile(f.path, buttons) });
          b.style.paddingLeft = `${14 + depth * 12}px`;
          buttons.push(b);
          out.push(b);
        }
        return out;
      };
      fill(tree, ...renderNode(buildTree(files), 0));
      fill(mobile, ...files.map((f) => h("option", { value: f.path, text: f.path })));
      const first = files.find((f) => /^wrangler\.(jsonc|json|toml)$/.test(f.path)) ?? files.find((f) => /readme/i.test(f.path)) ?? files[0];
      if (first) showRepoFile(first.path, buttons);
      else viewer.replaceChildren(h("div", { class: "placeholder", text: "ファイルがありません" }));
    };
    branch.addEventListener("change", () => load().catch((err) => fill(commits, h("div", { class: "notice", text: err.message }))));
    mobile.addEventListener("change", () => showRepoFile(mobile.value, [...tree.querySelectorAll(".file")]));
    page.append(
      h("div", { class: "section-head" }, h("h2", { text: "ファイル" }), h("label", { class: "inline" }, "ブランチ ", branch)),
      mobile,
      h("div", { class: "code-layout repo-code" }, tree, viewer),
      h("div", { class: "section-head" }, h("h2", { text: "コミット" }), h("span", { class: "muted", text: "直近 50 件" })),
      commits,
    );
    await load();
  } else {
    page.append(h("section", { class: "card empty" }, h("p", { text: "まだ push されていません。上のコマンドで push すると、ここにファイルとコミットが出ます。" })));
  }

  const delError = h("div", { class: "error" });
  page.append(
    h(
      "section",
      { class: "card" },
      h("h2", { text: "リポジトリの削除" }),
      h("p", { class: "muted", text: "リポジトリを削除します。サイトとデプロイ済みのリリースは残ります。" }),
      armed(h("button", { class: "danger" }), "リポジトリを削除", "もう一度押すと削除", async () => {
        try {
          await api(repoApi(""), { method: "DELETE" });
          await loadOverview();
          go(siteHash("deployments", name));
        } catch (err) {
          delError.textContent = err.message;
        }
      }),
      delError,
    ),
  );
  main.replaceChildren(page);
}

// ---------- 環境変数の編集 ----------

const domainSuffix = () => `.${state.overview.domain?.effective ?? location.host}`;

/** サブドメインの入力欄（右に .<ドメイン> を出す） */
function subdomainInput(value, label) {
  const input = h("input", { value, spellcheck: "false", autocomplete: "off", autocapitalize: "off", "aria-label": label, maxlength: "63" });
  input.addEventListener("input", () => {
    const v = input.value.toLowerCase();
    if (v !== input.value) input.value = v;
  });
  return { input, el: h("div", { class: "suffix-input" }, input, h("span", { class: "suffix mono", text: domainSuffix() })) };
}

/**
 * キーと値の行を足し引きする表。masked はシークレット用（値を伏せる）。
 * values() は { キー: 値 }。キーが空の行は無視する
 */
function envEditor(entries, { masked = false, placeholder = "値", note } = {}) {
  const rows = h("div", { class: "env-rows" });
  const add = (key = "", value = "") => {
    const k = h("input", { class: "mono", value: key, placeholder: "KEY", spellcheck: "false", autocomplete: "off", autocapitalize: "off", "aria-label": "名前" });
    const v = h("input", { class: "mono", value, placeholder, type: masked ? "password" : "text", spellcheck: "false", autocomplete: masked ? "new-password" : "off", "aria-label": "値" });
    const row = h("div", { class: "env-row" }, k, v, h("button", { class: "ghost icon", title: "この行を削除", "aria-label": "この行を削除", text: "×", onclick: () => row.remove() }));
    if (note) row.append(note(k, v));
    rows.append(row);
    return k;
  };
  for (const [k, v] of Object.entries(entries)) add(k, v);
  const el = h("div", {}, rows, h("button", { class: "add-row", text: "＋ 追加", onclick: () => add().focus() }));
  const values = () => {
    const out = {};
    for (const row of rows.children) {
      const [k, v] = row.querySelectorAll("input");
      const key = k.value.trim();
      if (key) {
        if (Object.hasOwn(out, key)) throw new Error(`「${key}」が 2 回あります`);
        out[key] = v.value;
      }
    }
    return out;
  };
  return { el, values, add };
}

/** wrangler の設定の vars（上書きできるが、ここでは編集しない） */
function wranglerVarsView(vars, overridden) {
  const entries = Object.entries(vars ?? {});
  if (!entries.length) return null;
  return h(
    "div",
    { class: "wrangler-vars" },
    h("div", { class: "log-title", text: "wrangler の設定の vars" }),
    h(
      "table",
      { class: "mono" },
      h(
        "tbody",
        {},
        ...entries.map(([k, v]) =>
          h("tr", { class: overridden(k) ? "overridden" : "" }, h("td", { text: k }), h("td", { text: typeof v === "string" ? v : JSON.stringify(v) }), h("td", { class: "muted", text: overridden(k) ? "上書き中" : "" })),
        ),
      ),
    ),
  );
}

/** デプロイ前の設定カード（GitHub の URL・サンプル） */
/**
 * GitHub の URL を読んだあとの確認カード。デプロイ先は作成済みのサイト（site）で、環境変数とシークレットを決めてからデプロイする。
 * cfg: inspect の結果（wrangler の vars）と、そのサイトの今の設定（current）
 */
function deployConfigCard(cfg, site, onBack) {
  const error = h("div", { class: "error" });
  const wrangler = cfg.vars ?? {};
  const current = cfg.current ?? { vars: {}, secretKeys: [] };
  const vars = envEditor({ ...wrangler, ...current.vars });
  const secrets = envEditor({}, { masked: true });

  const back = h("button", { text: "戻る", onclick: onBack });
  const deploy = h("button", { class: "primary", text: "デプロイ" });
  deploy.addEventListener("click", async () => {
    error.textContent = "";
    let body;
    try {
      const v = vars.values();
      // wrangler の設定と同じ値は保存しない（あとで wrangler の設定を変えたときに、古い値で上書きし続けないように）
      for (const [k, val] of Object.entries(v)) if (wrangler[k] === val && !Object.hasOwn(current.vars, k)) delete v[k];
      body = { url: cfg.repoUrl, name: site, vars: v, secrets: secrets.values() };
    } catch (err) {
      error.textContent = err.message;
      return;
    }
    back.disabled = true;
    busy(deploy, "デプロイ中…");
    await deployGitHub(body, (message) => {
      error.textContent = message;
      back.disabled = false;
      deploy.disabled = false;
      deploy.textContent = "デプロイ";
    });
  });

  return [
    h("section", { class: "card" }, h("h2", { text: "リポジトリ" }), h("code", { class: "value", text: cfg.repoUrl }), h("p", { class: "muted hint", text: `サイト ${site} にデプロイします。` })),
    h(
      "section",
      { class: "card" },
      h("h2", { text: "環境変数" }),
      h("p", { class: "muted", text: "Worker の env（nodejs_compat なら process.env も）に入ります。wrangler の設定の vars を初期値にしています。デプロイしたあとも「サイト設定」で変えられます。" }),
      vars.el,
    ),
    h(
      "section",
      { class: "card" },
      h("h2", { text: "シークレット" }),
      h("p", { class: "muted", text: "API キーなど。環境変数と同じく env に入りますが、保存したあとは値を表示しません。" }),
      current.secretKeys.length ? h("p", { class: "muted hint", text: `設定済み: ${current.secretKeys.join(", ")}（そのまま残ります）` }) : null,
      secrets.el,
    ),
    h("div", { class: "actions" }, back, deploy),
    error,
  ];
}

// ---------- サイトを追加 ----------

async function viewNewSite(main) {
  const page = h("div", { class: "page" }, pageHead("サイトを追加"));
  const sub = subdomainInput("", "サイト名");
  sub.input.placeholder = "my-app";
  const status = h("p", { class: "muted hint", text: "英小文字・数字・ハイフンで決めてください。あとから「サイト設定」でサブドメインを変えられます。" });
  const error = h("div", { class: "error" });
  const create = h("button", { class: "primary", text: "作成" });
  let timer = null;
  sub.input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const name = sub.input.value.trim();
      if (!name) return;
      const info = await api(`/site-name?name=${encodeURIComponent(name)}`).catch(() => null);
      if (!info) return;
      const bad = !info.valid || info.created || info.takenBy;
      status.classList.toggle("warn", !!bad);
      status.textContent = !info.valid
        ? "英小文字・数字・ハイフンで、63 文字以内にしてください。"
        : info.created
          ? `サイト ${name} は既にあります。`
          : info.takenBy
            ? `このサブドメインはサイト ${info.takenBy} が使っています。`
            : `${info.url} で配信するサイトを作ります。`;
    }, 250);
  });
  const run = async () => {
    error.textContent = "";
    create.disabled = true;
    try {
      const { name } = await api("/sites", { method: "POST", body: JSON.stringify({ name: sub.input.value.trim() }) });
      await loadOverview();
      go(siteHash("deployments", name));
    } catch (err) {
      error.textContent = err.message;
      create.disabled = false;
    }
  };
  create.addEventListener("click", run);
  sub.input.addEventListener("keydown", (e) => e.key === "Enter" && !e.isComposing && run());
  page.append(
    h(
      "section",
      { class: "card" },
      h("h2", { text: "サイト名（配信ドメイン）" }),
      h("p", { class: "muted", text: "サイトを作ると、次にデプロイの方法（サンプル・GitHub の公開リポジトリ・GitHub Actions・Kanzume のリポジトリ）を選べます。" }),
      h("div", { class: "row narrow" }, h("div", { class: "grow" }, sub.el), create),
      status,
      error,
    ),
  );
  const pending = state.sites.pending;
  if (pending.length) {
    page.append(h("div", { class: "section-head" }, h("h2", { text: "公開に至らなかったデプロイ" }), h("span", { class: "muted", text: `${pending.length} 件` })));
    const list = h("div", { class: "list" });
    for (const d of pending) list.append(deploymentItem(d, false));
    page.append(list);
  }
  sub.input.focus();
  main.replaceChildren(page);
}

// ---------- デプロイ方法（サイトごと） ----------

const DEPLOY_METHODS = [
  { key: "upload", title: "ファイルから", description: "フォルダ・ファイル・zip をドラッグ＆ドロップしてデプロイします。" },
  { key: "github", title: "GitHub の公開リポジトリから", description: "public リポジトリの URL を指定して、Kanzume の中でバンドルしてデプロイします。" },
  { key: "actions", title: "GitHub Actions から", description: "push のたびに Actions でビルドしてデプロイします。npm パッケージやビルドが必要なときに。" },
  { key: "repo", title: "サイトのリポジトリから", description: "Kanzume にこのサイトの Git リポジトリを作り、git push でデプロイします。GitHub は不要です。" },
];

/** サイトにデプロイする 4 つの方法。選んだ方法の中身を下に出す */
function deployOptions(detail) {
  const panel = h("div", { class: "deploy-panel" });
  const buttons = [];
  const choose = async (key) => {
    for (const b of buttons) b.classList.toggle("active", b.dataset.key === key);
    fill(panel, h("p", { class: "muted", text: "読み込み中…" }));
    try {
      fill(panel, ...(await METHOD_VIEWS[key](detail, () => choose(key))));
    } catch (err) {
      fill(panel, h("div", { class: "error", text: err.message }));
    }
  };
  const grid = h(
    "div",
    { class: "deploy-methods" },
    ...DEPLOY_METHODS.map((m) => {
      const b = h("button", { class: "deploy-method", "data-key": m.key, onclick: () => choose(m.key) }, h("b", { text: m.title }), h("span", { class: "muted", text: m.description }));
      buttons.push(b);
      return b;
    }),
  );
  return h("div", {}, grid, panel);
}

// ---------- ファイルのドラッグ＆ドロップでデプロイ ----------

const CONFIG_NAMES = ["wrangler.jsonc", "wrangler.json", "wrangler.toml"];
/** デプロイに含めないもの */
const UPLOAD_SKIP = /(^|\/)(\.git|node_modules|__MACOSX)(\/|$)|(^|\/)\.DS_Store$/;

// ドロップの場所を外したときに、ブラウザがファイルを開いて管理画面から離れないようにする
for (const type of ["dragover", "drop"]) window.addEventListener(type, (e) => e.dataTransfer?.types?.includes("Files") && e.preventDefault());

const readEntryFile = (entry) => new Promise((resolve, reject) => entry.file(resolve, reject));
async function readDirEntries(dir) {
  const reader = dir.createReader();
  const all = [];
  // readEntries は 100 件ずつしか返さないので、空になるまで読む
  for (;;) {
    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) return all;
    all.push(...batch);
  }
}

/** ドロップされたもの（フォルダを含む）を { path, file } の一覧にする */
async function droppedFiles(dataTransfer) {
  const entries = [...(dataTransfer.items ?? [])].map((i) => (i.kind === "file" ? i.webkitGetAsEntry?.() : null)).filter(Boolean);
  if (!entries.length) return [...dataTransfer.files].map((file) => ({ path: file.name, file }));
  const out = [];
  const walk = async (entry) => {
    if (UPLOAD_SKIP.test(entry.fullPath.slice(1))) return;
    if (entry.isFile) out.push({ path: entry.fullPath.replace(/^\/+/, ""), file: await readEntryFile(entry) });
    else if (entry.isDirectory) for (const child of await readDirEntries(entry)) await walk(child);
  };
  for (const e of entries) await walk(e);
  return out;
}

/** zip を展開する（stored と deflate。暗号化・ZIP64 は非対応） */
async function unzip(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip を読めませんでした（壊れているか、zip ではありません）");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  if (count === 0xffff || p === 0xffffffff) throw new Error("ZIP64 形式の zip には対応していません");
  const decoder = new TextDecoder();
  const out = [];
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error("zip のディレクトリが壊れています");
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = decoder.decode(buf.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    if (flags & 1) throw new Error("パスワード付きの zip には対応していません");
    if (compSize === 0xffffffff) throw new Error("ZIP64 形式の zip には対応していません");
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = buf.subarray(start, start + compSize);
    let data;
    if (method === 0) data = new Blob([raw]);
    else if (method === 8) data = await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).blob();
    else throw new Error(`zip の圧縮方式（${method}）に対応していません: ${name}`);
    out.push({ path: name, file: data });
  }
  return out;
}

/** 取り込むファイルを整える: 除くものを外し、zip を展開し、共通の先頭のフォルダを取る */
async function prepareUpload(files) {
  if (files.length === 1 && /\.zip$/i.test(files[0].path)) files = await unzip(files[0].file);
  files = files
    .map((f) => ({ ...f, path: f.path.replace(/\\/g, "/").replace(/^\/+/, "") }))
    .filter((f) => f.path && !UPLOAD_SKIP.test(f.path) && !f.path.split("/").some((s) => s === ".." || s === "."));
  // dist/ などのフォルダを丸ごと落としたときは、その中身をトップにする
  for (;;) {
    const first = files[0]?.path.split("/")[0];
    if (!first || !files.every((f) => f.path.startsWith(`${first}/`))) break;
    files = files.map((f) => ({ ...f, path: f.path.slice(first.length + 1) }));
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** ustar の tar（パスは pax ヘッダーに入れるので、長い名前や日本語も使える）を gzip にする */
async function tarGz(files) {
  const enc = new TextEncoder();
  const parts = [];
  const header = (name, size, type) => {
    const b = new Uint8Array(512);
    const put = (s, off, len) => b.set(enc.encode(s).subarray(0, len), off);
    const octal = (v, len) => `${v.toString(8).padStart(len - 1, "0")}\0`;
    put(name, 0, 100);
    put(octal(0o644, 8), 100, 8);
    put(octal(0, 8), 108, 8);
    put(octal(0, 8), 116, 8);
    put(octal(size, 12), 124, 12);
    put(octal(Math.floor(Date.now() / 1000), 12), 136, 12);
    put("        ", 148, 8);
    put(type, 156, 1);
    put("ustar\0", 257, 6);
    put("00", 263, 2);
    let sum = 0;
    for (const x of b) sum += x;
    put(`${octal(sum, 7)} `, 148, 8);
    return b;
  };
  const pad = (n) => new Uint8Array((512 - (n % 512)) % 512);
  for (const f of files) {
    const body = ` path=${f.path}\n`;
    let len = enc.encode(body).length;
    let record = `${len}${body}`;
    while (enc.encode(record).length !== len) {
      len = enc.encode(record).length;
      record = `${len}${body}`;
    }
    const pax = enc.encode(record);
    parts.push(header("PaxHeader", pax.length, "x"), pax, pad(pax.length));
    parts.push(header(f.path.slice(-100).replace(/[^\x20-\x7e]/g, "_"), f.file.size, "0"), f.file, pad(f.file.size));
  }
  parts.push(new Uint8Array(1024));
  return new Response(new Blob(parts).stream().pipeThrough(new CompressionStream("gzip"))).blob();
}

/** 取り込むファイルから、どうデプロイされるかを決める */
async function uploadPlan(files) {
  // サーバーと同じ優先順（wrangler.jsonc → wrangler.json → wrangler.toml）で選ぶ
  const config = CONFIG_NAMES.map((n) => files.find((f) => f.path === n)).find(Boolean);
  if (!config) return { config: null, worker: false, index: files.some((f) => f.path === "index.html") };
  const text = await config.file.text();
  const worker = config.path.endsWith(".toml") ? /^\s*main\s*=/m.test(text) : /"main"\s*:/.test(text);
  return { config: config.path, worker, index: true };
}

const METHOD_VIEWS = {
  async upload(detail) {
    const error = h("div", { class: "error" });
    const summary = h("div");
    const fileInput = h("input", { type: "file", multiple: true, hidden: true });
    const dirInput = h("input", { type: "file", webkitdirectory: true, hidden: true });
    const zone = h(
      "div",
      { class: "dropzone", tabindex: "0", role: "button", "aria-label": "フォルダ・ファイル・zip を選ぶ" },
      h("span", { class: "dropzone-icon", html: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>' }),
      // タッチの端末ではドラッグできないので、選ぶ案内にする
      h("b", { text: matchMedia("(hover: none)").matches ? "タップしてファイル・zip を選ぶ" : "ここにフォルダ・ファイル・zip をドロップ" }),
      h(
        "span",
        { class: "muted" },
        "または ",
        h("button", { type: "button", class: "link", text: "ファイルを選ぶ", onclick: (e) => {
          e.stopPropagation();
          fileInput.click();
        } }),
        "・",
        h("button", { type: "button", class: "link", text: "フォルダを選ぶ", onclick: (e) => {
          e.stopPropagation();
          dirInput.click();
        } }),
      ),
    );
    zone.addEventListener("click", () => fileInput.click());
    zone.addEventListener("keydown", (e) => {
      // 中の「ファイルを選ぶ」「フォルダを選ぶ」ボタンのキー操作は、そのボタンに任せる
      if (e.target !== zone) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        fileInput.click();
      }
    });

    const take = async (files) => {
      error.textContent = "";
      fill(summary, h("p", { class: "muted", text: "ファイルを読み込み中…" }));
      try {
        await show(await prepareUpload(files));
      } catch (err) {
        fill(summary);
        error.textContent = err.message;
      }
    };
    for (const input of [fileInput, dirInput]) {
      input.addEventListener("change", () => {
        const files = [...input.files].map((file) => ({ path: file.webkitRelativePath || file.name, file }));
        input.value = "";
        if (files.length) take(files);
      });
    }
    zone.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      zone.classList.add("over");
    });
    zone.addEventListener("dragleave", (e) => {
      if (!zone.contains(e.relatedTarget)) zone.classList.remove("over");
    });
    zone.addEventListener("drop", async (e) => {
      e.preventDefault();
      zone.classList.remove("over");
      // items はイベントの中でしか読めないので、先にファイルの一覧にする
      const pending = droppedFiles(e.dataTransfer);
      error.textContent = "";
      fill(summary, h("p", { class: "muted", text: "ファイルを読み込み中…" }));
      const files = await pending.catch((err) => {
        error.textContent = err.message;
        return null;
      });
      if (files) take(files);
      else fill(summary);
    });

    const show = async (files) => {
      if (!files.length) {
        fill(summary);
        error.textContent = "デプロイできるファイルがありません（.git・node_modules・.DS_Store は含めません）";
        return;
      }
      const plan = await uploadPlan(files);
      const size = files.reduce((n, f) => n + f.file.size, 0);
      const kind = plan.worker ? "dynamic" : "static";
      const deploy = h("button", { class: "primary", text: "このサイトにデプロイ" });
      const again = h("button", { text: "選び直す", onclick: () => {
          fill(summary);
          error.textContent = "";
        } });
      deploy.addEventListener("click", async () => {
        error.textContent = "";
        busy(deploy, "デプロイ中…");
        again.disabled = true;
        try {
          const body = await tarGz(files);
          const max = state.overview?.maxUploadBytes;
          if (max && body.size > max) throw new Error(`圧縮後 ${fmtBytes(body.size)} で、上限（${fmtBytes(max)}）を超えています`);
          const result = await api(siteApi("/deploy-upload"), { method: "POST", body, headers: { "content-type": "application/gzip" } });
          if (result.repoWarning) alert(result.repoWarning);
          await afterDeploy(detail.name);
        } catch (err) {
          error.textContent = err.message;
          deploy.disabled = false;
          deploy.textContent = "このサイトにデプロイ";
          again.disabled = false;
        }
      });
      const shown = files.slice(0, 8);
      fill(
        summary,
        h(
          "div",
          { class: "upload-summary" },
          h(
            "div",
            { class: "upload-head" },
            kindBadge(kind),
            h("b", { text: plan.config ? `${plan.config} の設定でデプロイします${plan.worker ? "（Worker あり）" : ""}` : "設定ファイルがないので、静的サイトとしてデプロイします" }),
          ),
          h("p", { class: "muted", text: `${files.length} ファイル・${fmtBytes(size)}` }),
          !plan.config && !plan.index ? h("p", { class: "warn", text: "トップに index.html がありません。/ を開くと 404 になります。" }) : null,
          h("ul", { class: "upload-files mono" }, ...shown.map((f) => h("li", {}, h("span", { text: f.path }), h("span", { class: "muted", text: fmtBytes(f.file.size) }))), files.length > shown.length ? h("li", { class: "muted", text: `ほか ${files.length - shown.length} ファイル` }) : null),
          h("div", { class: "actions" }, deploy, again),
        ),
      );
    };

    return [
      h(
        "section",
        { class: "card" },
        h("h2", { text: "ファイルから" }),
        h("p", { class: "muted", text: `ビルドしたフォルダやファイルを ${detail.name} にデプロイします。wrangler.jsonc / wrangler.toml があればその設定に従い（Worker はここでバンドルします）、なければ全体を静的サイトとして配信します。` }),
        h("p", { class: "muted", text: `デプロイしたファイルは、このサイトのリポジトリ（リポジトリタブ）にコミットとして保存します。手元にファイルがなくなっても git clone で取り出せます。` }),
        zone,
        fileInput,
        dirInput,
        summary,
        error,
      ),
    ];
  },

  async github(detail, reset) {
    // サンプル（KANZUME_SAMPLES_REPO で fork 先に変えられる）。取れなくてもデプロイはできるので、リンクを出さないだけにする
    const sample = (await api("/samples").catch(() => null))?.worker ?? null;
    const input = h("input", { type: "url", placeholder: "https://github.com/<owner>/<repo>/tree/<branch>/<dir>", spellcheck: "false", "aria-label": "GitHub の URL" });
    const error = h("div", { class: "error" });
    const next = h("button", { class: "primary", text: "次へ" });
    const box = h("div");
    const run = async () => {
      const url = input.value.trim();
      if (!url) {
        error.textContent = "GitHub の URL を入力してください";
        return input.focus();
      }
      error.textContent = "";
      busy(next, "読み込み中…");
      try {
        const [info, settings] = await Promise.all([api("/deploy-github/inspect", { method: "POST", body: JSON.stringify({ url }) }), api(`/sites/${encodeURIComponent(detail.name)}/settings`)]);
        fill(box, ...deployConfigCard({ ...info, repoUrl: url, current: { vars: settings.vars, secretKeys: settings.secretKeys } }, detail.name, reset));
        form.hidden = true;
      } catch (err) {
        error.textContent = err.message;
        next.disabled = false;
        next.textContent = "次へ";
      }
    };
    next.addEventListener("click", run);
    input.addEventListener("keydown", (e) => e.key === "Enter" && !e.isComposing && !next.disabled && run());
    const form = h(
      "section",
      { class: "card" },
      h("h2", { text: "GitHub の公開リポジトリから" }),
      h("p", { class: "muted", text: "wrangler の設定があるディレクトリの URL を入力してください。次の画面で環境変数とシークレットを確かめてからデプロイします。npm パッケージに依存するコードや、ビルドが必要なアセットは GitHub Actions を使ってください。" }),
      h("div", { class: "row" }, h("div", { class: "grow" }, input), next),
      sample ? h("p", { class: "field-hint" }, h("a", { href: sample, target: "_blank", rel: "noopener", text: "サンプルリポジトリはこちら ↗" })) : null,
      error,
    );
    setTimeout(() => input.focus());
    return [form, box];
  },

  async actions(detail) {
    return [
      h(
        "section",
        { class: "card" },
        h("h2", { text: "GitHub Actions から" }),
        h(
          "ol",
          { class: "steps muted" },
          h("li", {}, "「", h("a", { href: "#/settings", text: "設定 > トークン" }), "」で個人トークンを発行し、GitHub のリポジトリの Secrets に KANZUME_TOKEN として登録します。"),
          h("li", { text: `次のワークフローを置いて push します。デプロイ先は site のサイト（${detail.name}）で、wrangler の name は使いません。` }),
        ),
        h("div", { class: "card-head" }, h("span", { class: "mono", text: ".github/workflows/deploy.yml" }), copyButton(() => workflow(state.overview.url, detail.name))),
        h("pre", { class: "log", text: workflow(state.overview.url, detail.name) }),
      ),
    ];
  },

  async repo(detail) {
    const site = detail.name;
    if (!detail.repo) {
      const error = h("div", { class: "error" });
      const create = h("button", { class: "primary", text: "リポジトリを作成" });
      create.addEventListener("click", async () => {
        error.textContent = "";
        create.disabled = true;
        try {
          await api("/repos", { method: "POST", body: JSON.stringify({ name: site }) });
          go(siteHash("repo", site));
        } catch (err) {
          error.textContent = err.message;
          create.disabled = false;
        }
      });
      return [
        h(
          "section",
          { class: "card" },
          h("h2", { text: "サイトのリポジトリから" }),
          h("p", { class: "muted", text: `Kanzume に Git リポジトリ ${site} を作ります。main に push すると、wrangler の設定どおりにこのサイトへデプロイします。` }),
          create,
          error,
        ),
      ];
    }
    return [
      h(
        "section",
        { class: "card" },
        h("h2", { text: "サイトのリポジトリから" }),
        h("p", { class: "muted", text: `リポジトリ ${site} は作成済みです。push のコマンドとトークンはリポジトリのタブにあります。` }),
        h("a", { href: siteHash("repo", site), text: "リポジトリを開く →" }),
      ),
    ];
  },
};

/** サイトのリポジトリのタブ。まだなければ作成のボタンを出す */
async function viewRepoTab(main) {
  const detail = await loadSite();
  if (detail.repo) return viewRepo(main, detail.name);
  const page = h("div", { class: "page" }, pageHead("リポジトリ"), ...(await METHOD_VIEWS.repo(detail)));
  main.replaceChildren(page);
}

// ---------- start ----------

(async () => {
  try {
    const s = await api("/state");
    if (s.authenticated) await enterApp();
    else {
      $("setup-domain-field").hidden = !!s.domainFromEnv;
      $("setup-domain").value = location.host;
      const token = inviteToken();
      if (token && s.registered) await showInvite(token);
      else showAuth(s.registered ? "login" : "setup");
    }
  } catch (err) {
    showAuth("login");
    $("login-error").textContent = err.message;
  }
})();
