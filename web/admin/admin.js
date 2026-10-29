const BASE = "/_admin/kanzume";
const $ = (id) => document.getElementById(id);
const TABS = { deployments: "デプロイ", code: "コード", observability: "可観測性", settings: "設定" };

const state = {
  overview: null,
  site: null,
  tab: "deployments",
  token: "",
  showToken: false,
  timers: [],
  obs: { view: "overview", range: "24h", result: "", kind: "", q: "", live: false },
  code: { group: null, path: null },
  github: { url: "", error: "" },
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
  const res = await fetch(BASE + "/api" + path, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    credentials: "same-origin",
  });
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
  for (const id of ["auth-loading", "setup", "login"]) $(id).hidden = id !== view;
  if (view === "login") setAuthMode("signin");
}

$("register").addEventListener("click", async () => {
  $("setup-error").textContent = "";
  try {
    const options = await api("/register/options", { method: "POST", body: JSON.stringify({ setupToken: $("setup-token").value.trim() }) });
    const cred = await navigator.credentials.create({ publicKey: creationOptions(options) });
    await api("/register/verify", { method: "POST", body: JSON.stringify({ response: credentialJSON(cred) }) });
    await enterApp();
  } catch (err) {
    $("setup-error").textContent = err.message;
  }
});

function setAuthMode(mode) {
  const signup = mode === "signup";
  $("signin-panel").hidden = signup;
  $("signup-panel").hidden = !signup;
  $("mode-signin").classList.toggle("active", !signup);
  $("mode-signup").classList.toggle("active", signup);
  $("mode-signin").setAttribute("aria-selected", String(!signup));
  $("mode-signup").setAttribute("aria-selected", String(signup));
  $("login-error").textContent = "";
  if (signup) $("team-id").focus();
}
$("mode-signin").addEventListener("click", () => setAuthMode("signin"));
$("mode-signup").addEventListener("click", () => setAuthMode("signup"));

$("join").addEventListener("click", async () => {
  $("login-error").textContent = "";
  try {
    const options = await api("/register/options", { method: "POST", body: JSON.stringify({ teamId: $("team-id").value.trim() }) });
    const cred = await navigator.credentials.create({ publicKey: creationOptions(options) });
    await api("/register/verify", { method: "POST", body: JSON.stringify({ response: credentialJSON(cred) }) });
    await enterApp();
  } catch (err) {
    $("login-error").textContent = err.message;
  }
});

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
  await api("/logout", { method: "POST", body: "{}" }).catch(() => {});
  showAuth("login");
});

// ---------- shell ----------

function setMenu(open) {
  $("sidebar").classList.toggle("open", open);
  $("scrim").hidden = !open;
}
$("menu-open").addEventListener("click", () => setMenu(true));
$("scrim").addEventListener("click", () => setMenu(false));

for (const a of $("nav").querySelectorAll("a")) {
  a.addEventListener("click", (e) => {
    e.preventDefault();
    const tab = a.dataset.tab;
    location.hash = `#/${tab}`;
    setMenu(false);
  });
}

async function loadOverview() {
  [state.overview, state.site] = await Promise.all([api("/overview"), api("/site")]);
  state.token = state.overview.token;
  const link = $("site-link");
  link.hidden = !state.site.release;
  link.href = state.site.url;
  link.textContent = state.site.release ? state.site.release.name : "";
}

async function enterApp() {
  await loadOverview();
  $("auth").hidden = true;
  $("app").hidden = false;
  if (!TABS[parseHash()]) location.hash = "#/deployments";
  route();
}

function parseHash() {
  return location.hash.replace(/^#\/?/, "").split("/")[0] || "deployments";
}

function route() {
  if ($("app").hidden) return;
  clearTimers();
  const tab = TABS[parseHash()] ? parseHash() : "deployments";
  state.tab = tab;
  for (const a of $("nav").querySelectorAll("a")) a.classList.toggle("current", a.dataset.tab === tab);
  $("topbar-title").textContent = TABS[tab];
  const main = $("main");
  main.className = "main" + (tab === "code" && state.site?.release ? " fill" : "");
  main.scrollTop = 0;
  const views = { deployments: viewDeployments, code: viewCode, observability: viewObservability, settings: viewSettings };
  views[tab](main).catch((err) => {
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
    state.site?.release ? h("a", { class: "open", href: state.site.url, target: "_blank", rel: "noopener", text: "サイトを開く ↗" }) : null,
  );
}

function notDeployed(main, title) {
  main.replaceChildren(
    h(
      "div",
      { class: "page" },
      pageHead(title),
      h("div", { class: "card empty" }, h("p", { text: "まだサイトがデプロイされていません。" }), h("a", { href: "#/deployments", text: "デプロイのページを開く" })),
    ),
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

async function viewDeployments(main) {
  const [detail, { deployments, active }] = await Promise.all([api("/site"), api("/site/deployments")]);
  state.site = detail;
  const page = h("div", { class: "page" }, pageHead("デプロイ"));
  if (!detail.release) page.append(githubCard());

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
      ["URL", h("a", { href: detail.url, target: "_blank", rel: "noopener", text: detail.url })],
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
  page.append(current);

  page.append(h("div", { class: "card-head" }, h("h2", { text: "デプロイ履歴" }), h("span", { class: "muted", text: `${deployments.length} 件` })));
  const list = h("div", { class: "list" });
  for (const d of deployments) list.append(deploymentItem(d, d.release && d.release === active));
  if (!deployments.length) list.append(h("div", { class: "empty", text: "履歴はまだありません" }));
  page.append(list);
  main.replaceChildren(page);
}

function bindingTags(release) {
  return [
    release.main ? h("span", { class: "tag", text: "Worker" }) : h("span", { class: "tag", text: "静的サイト" }),
    release.assets ? h("span", { class: "tag", text: "Assets" }) : null,
    ...release.kv.map((b) => h("span", { class: "tag", text: `KV: ${b}` })),
    ...release.r2.map((b) => h("span", { class: "tag", text: `R2: ${b.binding}` })),
  ].filter(Boolean);
}

const EXAMPLE_URL = "https://github.com/kazukingzz/Kanzume/tree/main/examples/worker";

function githubCard() {
  const input = h("input", { type: "url", placeholder: EXAMPLE_URL, spellcheck: "false", "aria-label": "GitHub の URL", value: state.github.url });
  const error = h("div", { class: "error", text: state.github.error });
  const button = h("button", { class: "primary", text: "デプロイ" });
  const run = async () => {
    error.textContent = "";
    button.disabled = true;
    button.textContent = "デプロイ中…";
    state.github.url = input.value.trim();
    try {
      await api("/site/deploy-github", { method: "POST", body: JSON.stringify({ url: state.github.url || EXAMPLE_URL }) });
      state.github = { url: "", error: "" };
      await loadOverview();
    } catch (err) {
      state.github.error = err.message;
    }
    route();
  };
  button.addEventListener("click", run);
  input.addEventListener("keydown", (e) => e.key === "Enter" && run());
  return h(
    "section",
    { class: "card" },
    h("h2", { text: "GitHub の public リポジトリからデプロイ" }),
    h("p", { class: "muted", text: "wrangler の設定があるディレクトリの URL を入力してください。空のままならこのリポジトリのサンプルをデプロイします。npm パッケージに依存するコードや、ビルドが必要なアセットは GitHub Actions からデプロイしてください。" }),
    h("div", { class: "row" }, h("div", { class: "grow" }, input), button),
    error,
  );
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
            const full = await api(`/site/deployments/${encodeURIComponent(d.id)}`);
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
  const { groups } = await api("/site/files");
  if (!groups) return notDeployed(main, "コード");
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
  const file = await api(`/site/file?group=${group}&path=${encodeURIComponent(path)}`).catch((err) => ({ error: err.message }));
  if (state.code.group !== group || state.code.path !== path) return;
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
      h("div", { class: "placeholder" }, "バイナリファイルのため表示できません。", group === "assets" ? h("a", { href: state.site.url + path, target: "_blank", rel: "noopener", text: " 公開 URL で開く ↗" }) : null),
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
    String.raw`(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|` + "`(?:\\\\.|[^`\\\\])*`" + String.raw`)|\b(0x[\da-fA-F]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)\b|\b(` + KEYWORDS + String.raw`)\b`,
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
    out += esc(text.slice(last, m.index)) + `<span class="${classes[i - 1]}">${esc(m[0])}</span>`;
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
  if (!state.site?.release && !(await api("/site/deployments")).deployments.length) return notDeployed(main, "可観測性");
  const o = state.obs;
  const page = h("div", { class: "page" });
  const body = h("div");
  const seg = (items, value, onPick) =>
    h("div", { class: "segmented", role: "group" }, ...items.map(([v, label]) => h("button", { class: v === value ? "active" : "", "aria-pressed": String(v === value), text: label, onclick: () => onPick(v) })));
  page.append(
    pageHead("可観測性", [seg([["overview", "概要"], ["events", "イベント"]], o.view, (v) => ((o.view = v), route()))]),
    h("div", { class: "filters" }, seg(RANGES, o.range, (v) => ((o.range = v), route()))),
    body,
  );
  main.replaceChildren(page);
  if (o.view === "overview") await renderMetrics(body);
  else await renderEvents(body, page.querySelector(".filters"));
}

async function renderMetrics(body) {
  const load = async () => {
    const m = await api(`/site/metrics?range=${state.obs.range}`);
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
  const exp = Math.pow(10, Math.floor(Math.log10(target)));
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

function lineChart(el, buckets, series, xLabel, fmtY) {
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
  el.innerHTML = `<svg viewBox="0 0 ${f.w} ${f.hgt}" role="img" aria-label="実行時間の推移">${f.svg}${marks}<line class="crosshair" visibility="hidden" y1="${PAD.t}" y2="${PAD.t + f.ih}" x1="0" x2="0"/><g class="focus"></g><rect class="hit" x="${PAD.l}" y="${PAD.t}" width="${f.iw}" height="${f.ih}"/></svg>`;
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
    const { events } = await api(`/site/events?${params({})}`);
    list.replaceChildren(header(), ...events.map((e) => eventRow(e)));
    if (!events.length) list.append(h("div", { class: "empty", text: "この期間のイベントはありません" }));
    oldest = events.length ? events[events.length - 1].id : null;
    newest = events.length ? events[0].id : newest;
    if (events.length === 50) list.append(more);
  };

  more.addEventListener("click", async () => {
    more.disabled = true;
    const { events } = await api(`/site/events?${params({ before: String(oldest) })}`);
    more.remove();
    for (const e of events) list.append(eventRow(e));
    oldest = events.length ? events[events.length - 1].id : oldest;
    more.disabled = false;
    if (events.length === 50) list.append(more);
  });

  const poll = async () => {
    const { events } = await api(`/site/events?${params(newest ? { after: String(newest) } : {})}`);
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
  result.addEventListener("change", () => ((o.result = result.value), reload()));
  kind.addEventListener("change", () => ((o.kind = kind.value), reload()));
  live.addEventListener("click", () => ((o.live = !o.live), route()));

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
            renderEventDetail(detail, await api(`/site/events/${e.id}`));
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

const WORKFLOW = `name: Deploy to Kanzume
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
          url: \${{ vars.KANZUME_URL }}
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

async function viewSettings(main) {
  const page = h("div", { class: "page" }, pageHead("設定"));
  const tokenView = h("code", { class: "value grow", text: state.showToken ? state.token : "••••••••••••••••" });
  const toggle = h("button", { text: state.showToken ? "隠す" : "表示" });
  toggle.addEventListener("click", () => {
    state.showToken = !state.showToken;
    tokenView.textContent = state.showToken ? state.token : "••••••••••••••••";
    toggle.textContent = state.showToken ? "隠す" : "表示";
  });
  const rotateError = h("div", { class: "error" });
  const rotate = armed(h("button", { class: "danger" }), "Token を再発行", "もう一度押すと再発行", async () => {
    try {
      const { token } = await api("/token/rotate", { method: "POST", body: "{}" });
      state.token = token;
      tokenView.textContent = state.showToken ? token : "••••••••••••••••";
    } catch (err) {
      rotateError.textContent = err.message;
    }
  });

  page.append(
    h(
      "section",
      { class: "card" },
      h("h2", { text: "チーム" }),
      h("p", { class: "muted", text: "メンバーはログイン画面でこのチーム ID を入力すると、自分のパスキーを登録してログインできます。" }),
      h("div", { class: "field" }, h("label", { text: "チーム ID" }), h("div", { class: "row" }, h("code", { class: "value grow team-id", text: state.overview.teamId }), copyButton(() => state.overview.teamId))),
      h("p", { class: "muted", text: `登録済みのパスキー: ${state.overview.members} 件` }),
    ),
    h(
      "section",
      { class: "card" },
      h("h2", { text: "GitHub Actions からデプロイ" }),
      h("p", { class: "muted", text: "デプロイしたいリポジトリの Variables に KANZUME_URL、Secrets に KANZUME_TOKEN を登録してください。" }),
      h("div", { class: "field" }, h("label", { text: "KANZUME_URL" }), h("div", { class: "row" }, h("code", { class: "value grow", text: state.overview.url }), copyButton(() => state.overview.url))),
      h("div", { class: "field" }, h("label", { text: "KANZUME_TOKEN" }), h("div", { class: "row" }, tokenView, toggle, copyButton(() => state.token))),
      h("div", {}, rotate, h("p", { class: "muted", text: "再発行すると今の Token は使えなくなります。" }), rotateError),
    ),
    h("section", { class: "card" }, h("div", { class: "card-head" }, h("h2", { text: ".github/workflows/deploy.yml" }), copyButton(() => WORKFLOW)), h("pre", { class: "log", text: WORKFLOW })),
  );

  const detail = await api("/site");
  const r = detail.release;
  if (r) {
    const rows = [
      ["名前", r.name],
      ["URL", h("a", { href: detail.url, target: "_blank", rel: "noopener", text: detail.url })],
      ["Worker", r.main ? `worker/${r.main}` : "なし（静的サイト）"],
      ["compatibility_date", r.compatibilityDate ?? "–"],
      ["compatibility_flags", r.compatibilityFlags.length ? r.compatibilityFlags.join(", ") : "–"],
      ["KV", r.kv.length ? r.kv.join(", ") : "–"],
      ["R2", r.r2.length ? r.r2.map((b) => `${b.binding}（${b.bucket}）`).join(", ") : "–"],
      ["Assets", r.assets ? [`binding: ${r.assets.binding ?? "–"}`, `html_handling: ${r.assets.htmlHandling}`, `not_found_handling: ${r.assets.notFoundHandling}`, `run_worker_first: ${JSON.stringify(r.assets.runWorkerFirst)}`].join(" / ") : "–"],
    ];
    const vars = Object.entries(r.vars);
    page.append(
      h(
        "section",
        { class: "card" },
        h("h2", { text: "サイト" }),
        h("dl", { class: "kv" }, ...rows.flatMap(([k, v]) => [h("dt", { text: k }), h("dd", {}, v)])),
        h("div", { class: "log-title", text: "変数（vars）" }),
        vars.length ? h("table", { class: "mono" }, h("tbody", {}, ...vars.map(([k, v]) => h("tr", {}, h("td", { text: k }), h("td", { text: typeof v === "string" ? v : JSON.stringify(v) }))))) : h("p", { class: "muted", text: "なし" }),
        h("p", { class: "muted", text: "設定を変えるには wrangler の設定ファイルを編集して再デプロイしてください。" }),
      ),
    );
  }

  if (r || detail.latest) {
    const delError = h("div", { class: "error" });
    page.append(
      h(
        "section",
        { class: "card" },
        h("h2", { text: "サイトの削除" }),
        h("p", { class: "muted", text: "公開を止め、KV / R2 のデータ・デプロイ履歴・ログもすべて削除します。パスキーとチーム ID・Token は残ります。" }),
        armed(h("button", { class: "danger" }), "サイトを削除", "もう一度押すと削除", async () => {
          try {
            await api("/site", { method: "DELETE" });
            await loadOverview();
            location.hash = "#/deployments";
          } catch (err) {
            delError.textContent = err.message;
          }
        }),
        delError,
      ),
    );
  }
  main.replaceChildren(page);
}

// ---------- start ----------

(async () => {
  try {
    const s = await api("/state");
    if (s.authenticated) await enterApp();
    else showAuth(s.registered ? "login" : "setup");
  } catch (err) {
    showAuth("login");
    $("login-error").textContent = err.message;
  }
})();
