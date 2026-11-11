import { api } from "../core/api.js";
import { fill, h } from "../core/dom.js";
import { fmtBytes, fmtExpiration, prettyValue } from "../core/format.js";
import { siteApi, state } from "../core/state.js";
import { route } from "../shell.js";
import { armed, chooser, emptyState, pageHead } from "../ui/common.js";

export async function viewDatabase(main) {
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
      const edit = h("button", {
        text: "編集",
        onclick: () => fill(detail, editor({ key: k.key, value: value.text ?? "", metadata: value.metadata, expiration: value.expiration })),
      });
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
    const { keys, cursor } = await api(nsApi(`/keys?prefix=${encodeURIComponent(state.db.prefix)}&after=${encodeURIComponent(reset ? "" : after)}`)).finally(
      () => {
        if (mine === seq) more.disabled = false;
      },
    );
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
        await api(nsApi("/value"), {
          method: "PUT",
          body: JSON.stringify({ key: key.value, value: value.value, expirationTtl: ttl.value || null, metadata: initial?.metadata ?? null }),
        });
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
    h("p", {
      class: "muted data-summary",
      text: `名前空間（binding）${ns.name}・${ns.count} 件${ns.bound ? "" : "（今の wrangler の設定にはない名前空間です。データだけが残っています）"}`,
    }),
    addBox,
    list,
    more,
    error,
  );
  main.replaceChildren(page);
  await load(true);
}
