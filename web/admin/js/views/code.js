import { api } from "../core/api.js";
import { esc, h } from "../core/dom.js";
import { fmtBytes } from "../core/format.js";
import { siteApi, state, currentSiteUrl } from "../core/state.js";
import { loadSite, pageHead } from "../ui/common.js";

// ---------- コード ----------

export const GROUPS = [
  ["source", "ソースコード"],
  ["config", "設定"],
  ["worker", "Worker（変換後）"],
  ["assets", "アセット"],
];

export function buildTree(files) {
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

export async function viewCode(main) {
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

export async function showFile(viewer, group, path) {
  viewer.replaceChildren(h("div", { class: "viewer-head" }, h("span", { class: "path", text: path })), h("div", { class: "placeholder", text: "読み込み中…" }));
  const file = await api(siteApi(`/file?group=${group}&path=${encodeURIComponent(path)}`)).catch((err) => ({ error: err.message }));
  if (state.code.group !== group || state.code.path !== path) return;
  renderFile(viewer, path, file, group === "assets" && currentSiteUrl() ? currentSiteUrl() + path : null);
}

export function renderFile(viewer, path, file, publicUrl = null) {
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
      h(
        "div",
        { class: "placeholder" },
        "バイナリファイルのため表示できません。",
        publicUrl ? h("a", { href: publicUrl, target: "_blank", rel: "noopener", text: " 公開 URL で開く ↗" }) : null,
      ),
    );
  }
  const text = file.text;
  const lines = text.split("\n").length;
  const gutter = h("pre", { class: "gutter", "aria-hidden": "true", text: Array.from({ length: lines }, (_, i) => i + 1).join("\n") });
  const code = h("pre", { class: "lines", html: highlight(text, path) });
  viewer.replaceChildren(head, h("div", { class: "viewer-body" }, h("div", { class: "code-view" }, gutter, code)));
}

export const KEYWORDS =
  "const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|import|from|export|default|async|await|try|catch|finally|throw|typeof|instanceof|in|of|this|null|undefined|true|false|interface|type|satisfies|as|implements|enum|public|private|protected|readonly|static|get|set|yield|void|delete|super|declare|keyof";

export const RULES = {
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

export const EXT = {
  js: "js",
  mjs: "js",
  cjs: "js",
  jsx: "js",
  ts: "js",
  tsx: "js",
  mts: "js",
  cts: "js",
  json: "json",
  map: "json",
  jsonc: "jsonc",
  toml: "toml",
  css: "css",
  html: "html",
  htm: "html",
  svg: "html",
  xml: "html",
};

export function highlight(text, path) {
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
