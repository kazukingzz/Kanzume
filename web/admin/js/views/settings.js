import { registerPasskey } from "../auth.js";
import { api } from "../core/api.js";
import { fill, h } from "../core/dom.js";
import { fmtAgo, fmtDate } from "../core/format.js";
import { isAdmin, state } from "../core/state.js";
import { siteHash } from "../shell.js";
import { TTL_OPTIONS, armed, copyButton, pageHead } from "../ui/common.js";

export function passkeyList() {
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

export function passkeyItem(p, i, reload, removable) {
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
    fill(
      item,
      h("div", { class: "grow" }, h("div", { class: "passkey-name", text: label }), h("div", { class: "muted passkey-meta", text: meta.join(" · ") }), error),
      rename,
      remove,
    );
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
    fill(
      item,
      h(
        "div",
        { class: "grow" },
        h("div", { class: "row" }, input, h("button", { class: "primary", text: "保存", onclick: save }), h("button", { text: "キャンセル", onclick: show })),
        error,
      ),
    );
    input.focus();
    input.select();
  }
  show();
  return item;
}

// ---------- 設定（個人） ----------

export async function viewSettings(main) {
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
      ? h(
          "ul",
          { class: "secrets" },
          ...me.sites.map((name) =>
            h(
              "li",
              { class: "secret" },
              h("a", { class: "grow", href: siteHash("deployments", name), text: name }),
              h("span", { class: "muted", text: "メンバー" }),
            ),
          ),
        )
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
      h(
        "section",
        { class: "card" },
        h("h2", { text: "パスキー" }),
        h("p", { class: "muted", text: "別のデバイスからもサインインできるように、パスキーを追加できます。" }),
        list,
        h("div", { class: "actions" }, addPasskey),
        addError,
      ),
    ),
  );
}

/** 個人トークン（git push のパスワードと、GitHub Actions の KANZUME_TOKEN に使う） */
export function personalTokensCard() {
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
            h(
              "div",
              { class: "grow" },
              h("div", { class: "title", text: t.name }),
              h("div", { class: "sub", text: `発行 ${fmtDate(t.createdAt)} · ${t.expiresAt ? `期限 ${fmtDate(t.expiresAt)}` : "無期限"}` }),
            ),
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
          h(
            "div",
            { class: "row" },
            h("code", { class: "value grow", text: t.token }),
            copyButton(() => t.token),
          ),
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
