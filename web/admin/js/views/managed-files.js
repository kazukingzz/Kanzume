import { api } from "../core/api.js";
import { fill, h } from "../core/dom.js";
import { siteApi } from "../core/state.js";
import { armed, copyButton } from "../ui/common.js";

// ---------- Kanzume が代わりに返すファイル（robots.txt・security.txt） ----------
// サイトのデプロイしたファイルになく、設定が有効なときに返す。全体の既定は管理者設定、サイトごとの上書きはサイト設定

const POLICIES = [
  ["search", "検索", "検索の索引を作り、検索結果にリンクや短い抜粋を出すこと"],
  ["agent", "AI エージェント", "AI の回答を作るときに、その場で内容を読んで使うこと"],
  ["training", "AI の学習", "AI モデルの学習や調整に使うこと。「拒否」にすると、学習用のクローラー（GPTBot・ClaudeBot・CCBot など）に Disallow も出す"],
];

/** 有効にするスイッチ（チェックボックス） */
function enableSwitch(checked, text) {
  const input = h("input", { type: "checkbox" });
  input.checked = checked;
  return { input, el: h("label", { class: "inline switch" }, input, text) };
}

/** 許可 / 拒否 の切り替え */
function policyToggle(value, label) {
  let current = value;
  const buttons = [
    ["allow", "許可"],
    ["block", "拒否"],
  ].map(([v, text]) => h("button", { type: "button", text, "data-value": v }));
  const paint = () => {
    for (const b of buttons) {
      const active = b.dataset.value === current;
      b.classList.toggle("active", active);
      b.setAttribute("aria-pressed", String(active));
    }
  };
  for (const b of buttons)
    b.addEventListener("click", () => {
      current = b.dataset.value;
      paint();
    });
  paint();
  return { el: h("div", { class: "segmented", role: "group", "aria-label": label }, ...buttons), value: () => current };
}

/**
 * robots.txt のフォーム。read() で入力を設定の形にする。
 * forSite: サイトの「このサイトだけ変える」で使う（有効のスイッチは出さず、常に有効。返さないなら「このサイトでは返さない」を選ぶ）
 */
function robotsForm(config, forSite = false) {
  const enabled = enableSwitch(forSite || config.enabled, "robots.txt のないサイトに、この内容の robots.txt を返す");
  const toggles = {};
  const rows = POLICIES.map(([key, label, hint]) => {
    toggles[key] = policyToggle(config[key], label);
    return h(
      "div",
      { class: "policy-row" },
      h("div", { class: "grow" }, h("div", { class: "policy-name", text: label }), h("div", { class: "field-hint", text: hint })),
      toggles[key].el,
    );
  });
  const extra = h("textarea", {
    class: "mono",
    rows: "4",
    spellcheck: "false",
    "aria-label": "追加のルール",
    placeholder: "Sitemap: https://example.com/sitemap.xml\nUser-agent: *\nDisallow: /private/",
  });
  extra.value = config.extra ?? "";
  return {
    el: h(
      "div",
      { class: "managed-form" },
      forSite ? null : enabled.el,
      h("div", { class: "policy-list" }, ...rows),
      h("div", { class: "field" }, h("label", { text: "追加のルール（そのまま末尾に足します）" }), extra),
    ),
    read: () => ({
      enabled: enabled.input.checked,
      search: toggles.search.value(),
      agent: toggles.agent.value(),
      training: toggles.training.value(),
      extra: extra.value,
    }),
  };
}

/** 保存している日時（ISO）を、日付の入力欄の値（YYYY-MM-DD）にする */
const dateValue = (iso) => (iso ? new Date(iso).toISOString().slice(0, 10) : "");

const SECURITY_FIELDS = [
  ["encryption", "Encryption", "報告を暗号化するための鍵の URL", "https://example.com/pgp-key.txt"],
  ["acknowledgements", "Acknowledgements", "報告してくれた人への謝辞のページ", "https://example.com/hall-of-fame"],
  ["canonical", "Canonical", "この security.txt の正式な URL", "https://example.com/.well-known/security.txt"],
  ["hiring", "Hiring", "セキュリティ関連の求人のページ", "https://example.com/jobs"],
  ["policy", "Policy", "脆弱性の報告の受け付け方針のページ", "https://example.com/security-policy"],
];

/** security.txt のフォーム（forSite は robotsForm と同じ） */
function securityTxtForm(config, forSite = false) {
  const enabled = enableSwitch(forSite || config.enabled, "security.txt のないサイトに、この内容の security.txt を返す");
  const contacts = h("div", { class: "contact-list" });
  const addContact = (value = "") => {
    const input = h("input", {
      class: "mono",
      value,
      placeholder: "mailto:security@example.com",
      spellcheck: "false",
      autocomplete: "off",
      "aria-label": "Contact",
    });
    const row = h(
      "div",
      { class: "row" },
      h("div", { class: "grow" }, input),
      h("button", { type: "button", class: "ghost", text: "外す", onclick: () => row.remove() }),
    );
    contacts.append(row);
    return input;
  };
  for (const c of config.contact?.length ? config.contact : [""]) addContact(c);
  const expires = h("input", { type: "date", value: dateValue(config.expires), "aria-label": "期限" });
  const expired = config.expires && new Date(config.expires).getTime() < Date.now();
  const fields = {};
  const optional = SECURITY_FIELDS.map(([key, label, hint, placeholder]) => {
    fields[key] = h("input", { class: "mono", value: config[key] ?? "", placeholder, spellcheck: "false", autocomplete: "off", "aria-label": label });
    return h("div", { class: "field" }, h("label", { text: `${label}（${hint}）` }), fields[key]);
  });
  const languages = h("input", {
    class: "mono",
    value: config.preferredLanguages ?? "",
    placeholder: "ja, en",
    spellcheck: "false",
    autocomplete: "off",
    "aria-label": "Preferred languages",
  });
  return {
    el: h(
      "div",
      { class: "managed-form" },
      forSite ? null : enabled.el,
      h(
        "div",
        { class: "field" },
        h("label", { text: "Contact（必須。mailto:・tel:・https:// のどれかで始める）" }),
        contacts,
        h("button", { type: "button", class: "ghost", text: "＋ 追加", onclick: () => addContact().focus() }),
      ),
      h(
        "div",
        { class: "field" },
        h("label", { text: "期限（必須。この日を過ぎると古い情報として扱われます。1 年以内がおすすめ）" }),
        expires,
        expired ? h("div", { class: "field-hint warn", text: "期限が切れています。新しい日付にしてください。" }) : null,
      ),
      ...optional,
      h("div", { class: "field" }, h("label", { text: "Preferred languages（対応できる言語）" }), languages),
    ),
    read: () => ({
      enabled: enabled.input.checked,
      contact: [...contacts.querySelectorAll("input")].map((i) => i.value.trim()).filter(Boolean),
      // その日の終わり（UTC）までを有効にする
      expires: expires.value ? `${expires.value}T23:59:59Z` : "",
      ...Object.fromEntries(Object.entries(fields).map(([k, input]) => [k, input.value.trim()])),
      preferredLanguages: languages.value.trim(),
    }),
  };
}

const FORMS = { robots: robotsForm, securityTxt: securityTxtForm };
const TITLES = { robots: "robots.txt", securityTxt: "security.txt" };

/** 返す中身（コピーできる）。返していないときは、同じ枠にその理由を出す（保存の前後で、位置と見た目を変えない） */
function previewBox(content, emptyText) {
  return h(
    "div",
    { class: "managed-preview" },
    h("div", { class: "row" }, h("div", { class: "log-title grow", text: "返す内容" }), content ? copyButton(() => content) : null),
    content ? h("pre", { class: "log", text: content }) : h("div", { class: "managed-empty", text: emptyText }),
  );
}

/** 保存する前の入力から、返す内容を作って見せるボタン */
function previewButton(kind, read, target, error) {
  return h("button", {
    type: "button",
    text: "プレビュー",
    onclick: async () => {
      error.textContent = "";
      try {
        const { content } = await api("/managed-files/preview", { method: "POST", body: JSON.stringify({ kind, config: read() }) });
        fill(target, previewBox(content, ""));
      } catch (err) {
        error.textContent = err.message;
      }
    },
  });
}

// ---------- 管理者設定: 全体の既定 ----------

const GLOBAL_INTRO = {
  robots:
    "robots.txt のないサイトに、Kanzume が代わりの robots.txt を返します。検索・AI エージェント・AI の学習のそれぞれについて、内容を使ってよいかを伝えます（クローラーへのお願いで、強制はできません）。サイトごとに「サイト設定」で変えられます。",
  securityTxt:
    "脆弱性を見つけた人が連絡できるように、連絡先を /.well-known/security.txt で公開します。security.txt のないサイトに、Kanzume が代わりに返します。サイトごとに「サイト設定」で変えられます。",
};

function globalCard(kind, data, reload) {
  const form = FORMS[kind](data[kind]);
  const error = h("div", { class: "error" });
  const done = h("span", { class: "muted" });
  const preview = h("div", {}, previewBox(data.preview[kind], "今は返していません。有効にして保存すると、ここに内容が出ます。"));
  const save = h("button", { class: "primary", text: "保存" });
  save.addEventListener("click", async () => {
    error.textContent = "";
    done.textContent = "";
    save.disabled = true;
    try {
      await api("/managed-files", { method: "PUT", body: JSON.stringify({ [kind]: form.read() }) });
      await reload();
    } catch (err) {
      error.textContent = err.message;
      save.disabled = false;
    }
  });
  const hasSaved = kind === "securityTxt" && (data.securityTxt.contact.length > 0 || data.securityTxt.expires);
  const remove = hasSaved
    ? armed(h("button", { class: "danger" }), "削除", "もう一度押すと削除", async () => {
        try {
          await api("/managed-files", { method: "PUT", body: JSON.stringify({ securityTxt: null }) });
          await reload();
        } catch (err) {
          error.textContent = err.message;
        }
      })
    : null;
  return h(
    "section",
    { class: "card managed-card" },
    h(
      "div",
      { class: "card-head" },
      h("h2", { text: kind === "robots" ? "クローラーへの指示（robots.txt）" : "security.txt" }),
      h("span", { class: `status ${data[kind].enabled ? "good" : "neutral"}`, text: data[kind].enabled ? "有効" : "無効" }),
    ),
    h("p", { class: "muted", text: GLOBAL_INTRO[kind] }),
    form.el,
    h("div", { class: "actions" }, save, previewButton(kind, form.read, preview, error), remove, done),
    error,
    preview,
  );
}

/** 管理者設定に出す 2 枚のカード（保存したら読み直して描き直す） */
export async function managedFilesCards() {
  const wrap = h("div", { class: "managed-files" });
  const render = async () => {
    const data = await api("/managed-files");
    fill(wrap, globalCard("robots", data, render), globalCard("securityTxt", data, render));
  };
  await render();
  return wrap;
}

// ---------- サイト設定: このサイトでの上書き ----------

const MODES = [
  ["default", "全体の既定に従う"],
  ["custom", "このサイトだけ変える"],
  ["off", "このサイトでは返さない"],
];

/** 今このサイトで何が返っているか */
function siteStatus(kind, entry) {
  const name = TITLES[kind];
  if (entry.ownFile)
    return h("div", {
      class: "notice info",
      text: `このサイトにはデプロイした ${name} があるので、そちらを返しています（下の設定は、ファイルがなくなったときに使われます）。`,
    });
  if (entry.content) return previewBox(entry.content, "");
  const why = entry.mode === "default" && !entry.defaultEnabled ? "全体の既定が無効なので、" : "";
  return previewBox(null, `${why}Kanzume は ${name} を返していません。`);
}

function siteSection(kind, entry, reload) {
  const select = h("select", { "aria-label": `${TITLES[kind]} の設定` }, ...MODES.map(([value, text]) => h("option", { value, text })));
  select.value = entry.mode;
  const formBox = h("div");
  const error = h("div", { class: "error" });
  const preview = h("div", {}, siteStatus(kind, entry));
  let form = null;
  const paint = () => {
    form = select.value === "custom" ? FORMS[kind](entry.config, true) : null;
    fill(formBox, form?.el);
    previewBtn.hidden = !form;
  };
  const previewBtn = previewButton(kind, () => form.read(), preview, error);
  const save = h("button", { class: "primary", text: "保存" });
  save.addEventListener("click", async () => {
    error.textContent = "";
    save.disabled = true;
    try {
      const body = select.value === "custom" ? { mode: "custom", config: form.read() } : { mode: select.value };
      await api(siteApi("/managed-files"), { method: "PUT", body: JSON.stringify({ [kind]: body }) });
      await reload();
    } catch (err) {
      error.textContent = err.message;
      save.disabled = false;
    }
  });
  select.addEventListener("change", paint);
  paint();
  return h(
    "div",
    { class: "managed-section" },
    h("div", { class: "row" }, h("h3", { class: "grow", text: `${TITLES[kind]}（${entry.path}）` }), select),
    formBox,
    h("div", { class: "actions" }, save, previewBtn),
    error,
    preview,
  );
}

/** サイト設定に出すカード */
export async function siteManagedFilesCard() {
  const card = h("section", { class: "card managed-card" });
  const render = async () => {
    const data = await api(siteApi("/managed-files"));
    fill(
      card,
      h("h2", { text: "Kanzume が返すファイル" }),
      h("p", {
        class: "muted",
        text: "デプロイしたファイルに robots.txt・security.txt がないとき、Kanzume が代わりに返します。Worker があるサイトでも、有効なら Worker を呼ばずに返します（Worker に返させたいときは「このサイトでは返さない」にします）。",
      }),
      siteSection("robots", data.robots, render),
      siteSection("securityTxt", data.securityTxt, render),
    );
  };
  await render();
  return card;
}
