import { viewInvite } from "./auth.js";
import { api } from "./core/api.js";
import { $, fill, h } from "./core/dom.js";
import { ADMIN_TABS, DEPLOYED_TABS, GLOBAL_TABS, NEW_SITE, SITE_TABS, clearTimers, hostOf, isAdmin, state } from "./core/state.js";
import { kindBadge } from "./ui/common.js";
import { viewAdmin } from "./views/admin.js";
import { viewCode } from "./views/code.js";
import { viewDatabase } from "./views/database.js";
import { viewDeployments } from "./views/deployments.js";
import { viewNewSite } from "./views/new-site.js";
import { viewObservability } from "./views/observability.js";
import { viewRepoTab } from "./views/repo.js";
import { viewResources } from "./views/resources.js";
import { viewSettings } from "./views/settings.js";
import { viewSite } from "./views/site.js";
import { viewStorage } from "./views/storage.js";

// ---------- shell ----------

export function setMenu(open) {
  $("sidebar").classList.toggle("open", open);
  $("scrim").hidden = !open;
}

$("menu-open").addEventListener("click", () => setMenu(true));

$("scrim").addEventListener("click", () => setMenu(false));

/** 画面を移る。同じハッシュのときは hashchange が起きないので、自分で描き直す */
export function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

export const siteHash = (tab, name = state.siteName) => (name ? `#/${encodeURIComponent(name)}/${tab}` : "#/new");

for (const a of $("nav").querySelectorAll("a")) {
  a.addEventListener("click", (e) => {
    e.preventDefault();
    const tab = a.dataset.tab;
    go(SITE_TABS[tab] ? siteHash(tab) : `#/${tab}`);
    setMenu(false);
  });
}

// ---------- サイトの切り替え（自作のドロップダウン） ----------

export const picker = { open: false, active: -1, items: [] };

export function chooseSite(value) {
  closePicker(true);
  const tab = SITE_TABS[state.tab] ? state.tab : "deployments";
  const next = value === NEW_SITE ? "#/new" : siteHash(tab, value);
  setMenu(false);
  go(next);
}

export const pickerItems = () => [...state.sites.sites.map((x) => x.name), ...(isAdmin() ? [NEW_SITE] : [])];

export function renderPickerMenu() {
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
          h(
            "span",
            { class: "site-option-host" },
            x.name === state.sites.root ? h("span", { class: "root-badge", text: "ルート" }) : null,
            x.deployed ? hostOf(x.url) : `${hostOf(x.subdomainUrl)}・未デプロイ`,
          ),
        ),
      ),
    ),
    state.sites.sites.length
      ? isAdmin()
        ? h("li", { class: "site-menu-sep", role: "presentation" })
        : null
      : h("li", { class: "site-menu-empty", role: "presentation", text: isAdmin() ? "サイトはまだありません" : "参加しているサイトはありません" }),
    isAdmin()
      ? option(
          NEW_SITE,
          picker.items.length - 1,
          check(),
          h("span", { class: "site-option-text" }, h("span", { class: "site-option-name", text: "＋ サイトを追加" })),
        )
      : null,
  );
  if (picker.active >= 0) menu.setAttribute("aria-activedescendant", `site-option-${picker.active}`);
  else menu.removeAttribute("aria-activedescendant");
}

export function setActive(i) {
  if (i === picker.active) return;
  picker.active = i;
  const menu = $("site-menu");
  for (const el of menu.querySelectorAll(".site-option")) el.classList.toggle("active", el.id === `site-option-${i}`);
  menu.setAttribute("aria-activedescendant", `site-option-${i}`);
  $(`site-option-${i}`)?.scrollIntoView({ block: "nearest" });
}

export function openPicker() {
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

export function closePicker(focusTrigger = false) {
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

export async function loadOverview() {
  [state.overview, state.sites] = await Promise.all([api("/overview"), api("/sites")]);
}

export function renderShell() {
  const current = state.tab === "new" ? null : state.sites.sites.find((x) => x.name === state.siteName);
  const name = $("site-trigger-name");
  name.textContent = current
    ? current.name
    : state.tab === "new"
      ? "＋ サイトを追加"
      : state.sites.sites.length
        ? "サイトを選択"
        : isAdmin()
          ? "サイトがありません"
          : "参加しているサイトはありません";
  name.classList.toggle("placeholder", !current && state.tab !== "new");
  fill(
    $("site-trigger-host"),
    current ? [kindBadge(current.kind), current.deployed ? hostOf(current.url) : `${hostOf(current.subdomainUrl)}・未デプロイ`] : [],
  );
  closePicker();
  for (const a of $("nav").querySelectorAll("a")) {
    const tab = a.dataset.tab;
    // href を付けて、キーボードで選べる・新しいタブで開けるリンクにする
    a.href = SITE_TABS[tab] ? siteHash(tab) : `#/${tab}`;
    a.classList.toggle("current", tab === state.tab);
    if (tab === state.tab) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
    a.hidden =
      (!!SITE_TABS[a.dataset.tab] && !current) || (DEPLOYED_TABS.has(a.dataset.tab) && !current?.deployed) || (ADMIN_TABS.has(a.dataset.tab) && !isAdmin());
  }
  $("topbar-title").textContent = current ? current.name : (GLOBAL_TABS[state.tab] ?? "");
}

export async function enterApp() {
  await loadOverview();
  $("auth").hidden = true;
  $("app").hidden = false;
  route();
}

export function parseHash() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  // 以前の全体のリポジトリの URL（#/repos/<名前>）は、そのサイトのリポジトリのタブへ
  if (parts[0] === "repos") return { site: parts[1] ?? null, tab: "repo" };
  if (parts[0] === "invite") return { site: null, tab: "invite", invite: parts[1] ?? "" };
  if (parts.length >= 2) return { site: parts[0], tab: parts[1] };
  return { site: null, tab: parts[0] ?? "" };
}

/**
 * 表示に渡す main。画面を移ったあとに、移る前に始めた表示の読み込みが終わっても描かない・タイマーを足さない
 * （遅れて返った表示が今の画面を上書きしたり、ほかのサイトの画面が混ざったりしないように）
 */
function viewTarget(el) {
  const gen = ++state.gen;
  const current = () => gen === state.gen;
  return {
    get current() {
      return current();
    },
    get className() {
      return el.className;
    },
    set className(v) {
      if (current()) el.className = v;
    },
    replaceChildren(...nodes) {
      if (current()) el.replaceChildren(...nodes);
    },
    /** 表示しているあいだだけ動くタイマー（画面を移ると止まる） */
    every(ms, fn) {
      if (current()) state.timers.push(setInterval(fn, ms));
    },
  };
}

export function route() {
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
    const first = names.includes(state.siteName) ? state.siteName : state.sites.root && names.includes(state.sites.root) ? state.sites.root : names[0];
    location.replace(first ? siteHash(SITE_TABS[tab] ? tab : "deployments", first) : home);
    return;
  }
  state.tab = tab;
  renderShell();
  const main = viewTarget($("main"));
  main.className = `main${tab === "code" ? " fill" : ""}`;
  $("main").scrollTop = 0;
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
