import { api } from "../core/api.js";
import { fill, h } from "../core/dom.js";
import { fmtDate } from "../core/format.js";
import { isAdmin, siteApi, state } from "../core/state.js";
import { go, loadOverview, route, siteHash } from "../shell.js";
import { KIND, armed, copyButton, kindBadge, kindBanner, loadSite, pageHead, releaseKind, siteUrlCell } from "../ui/common.js";

// ---------- サイト設定 ----------

export async function viewSite(main) {
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
        [
          "Assets",
          r.assets
            ? [
                `binding: ${r.assets.binding ?? "–"}`,
                `html_handling: ${r.assets.htmlHandling}`,
                `not_found_handling: ${r.assets.notFoundHandling}`,
                `run_worker_first: ${JSON.stringify(r.assets.runWorkerFirst)}`,
              ].join(" / ")
            : "–",
        ],
      ];
  const settings = await api(siteApi("/settings"));

  const delError = h("div", { class: "error" });
  // 権限や未デプロイで出さないカードは null になるので、DOM の append（null を文字として足す）ではなく fill を使う
  fill(
    page,
    ...page.childNodes,
    h("section", { class: "card" }, h("h2", { text: "サイト" }), h("dl", { class: "kv" }, ...rows.flatMap(([k, v]) => [h("dt", { text: k }), h("dd", {}, v)]))),
    ...siteSettingsCards(settings),
    isAdmin() ? siteMembersCard() : null,
    h(
      "section",
      { class: "card" },
      h("h2", { text: "サイトの削除" }),
      h("p", {
        class: "muted",
        text: "公開を止め、このサイトの KV / R2 のデータ・デプロイ履歴・ログと、同じ名前のリポジトリをすべて削除します。ほかのサイトとメンバーのパスキーは残ります。",
      }),
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
export function siteMembersCard() {
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
                  h("span", {
                    class: "grow muted",
                    text: `${fmtDate(i.createdAt)} に${i.createdBy ? ` ${i.createdBy} が` : ""}作成 · ${fmtDate(i.expiresAt).slice(0, 10)} まで`,
                  }),
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
          h(
            "div",
            { class: "row" },
            h("code", { class: "value grow", text: invite.url }),
            copyButton(() => invite.url),
          ),
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
    h("p", {
      class: "muted",
      text: `招待リンクを開いた人がパスキーを登録すると、${site} のメンバーになります。メンバーはこのサイトのデプロイ・設定・削除と、同じ名前のリポジトリを扱えます。ほかのサイトや管理者設定は見えません。`,
    }),
    h("div", { class: "actions" }, create),
    issued,
    body,
    error,
  );
}

/** サイト設定のサブドメイン・環境変数・シークレット。保存するとすぐ（次のリクエストから）反映される */
export function siteSettingsCards(settings) {
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
    fill(
      varsBox,
      wranglerVarsView(wrangler, (k) => Object.hasOwn(current, k)),
    );
  };
  renderWrangler();
  vars.el.addEventListener("input", renderWrangler);
  vars.el.addEventListener("click", () => setTimeout(renderWrangler));
  const varsError = h("div", { class: "error" });
  const varsDone = h("p", { class: "muted hint" });
  const varsSave = h("button", { class: "primary", text: "保存" });
  varsSave.addEventListener(
    "click",
    saveWith(varsSave, varsError, varsDone, () => ({ vars: vars.values() })),
  );

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
            const input = h("input", {
              class: "mono",
              type: "password",
              placeholder: "新しい値",
              autocomplete: "new-password",
              "aria-label": `${key} の新しい値`,
            });
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
      h("p", {
        class: "muted",
        text: `変えると前のサブドメインでは配信しなくなります。サイトの ID（${state.siteName}）は変わらないので、GitHub Actions の site やリポジトリの名前はそのままで構いません。`,
      }),
      h("div", { class: "row narrow" }, h("div", { class: "grow" }, sub.el), subSave),
      subError,
      subDone,
    ),
    h(
      "section",
      { class: "card" },
      h("h2", { text: "環境変数" }),
      h("p", {
        class: "muted",
        text: "Worker の env（nodejs_compat なら process.env も）に入ります。wrangler の設定の vars と同じ名前なら、こちらが優先されます。再デプロイしなくても、保存した次のリクエストから反映されます。",
      }),
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

// ---------- 環境変数の編集 ----------

export const domainSuffix = () => `.${state.overview.domain?.effective ?? location.host}`;

/** サブドメインの入力欄（右に .<ドメイン> を出す） */
export function subdomainInput(value, label) {
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
export function envEditor(entries, { masked = false, placeholder = "値", note } = {}) {
  const rows = h("div", { class: "env-rows" });
  const add = (key = "", value = "") => {
    const k = h("input", {
      class: "mono",
      value: key,
      placeholder: "KEY",
      spellcheck: "false",
      autocomplete: "off",
      autocapitalize: "off",
      "aria-label": "名前",
    });
    const v = h("input", {
      class: "mono",
      value,
      placeholder,
      type: masked ? "password" : "text",
      spellcheck: "false",
      autocomplete: masked ? "new-password" : "off",
      "aria-label": "値",
    });
    const row = h(
      "div",
      { class: "env-row" },
      k,
      v,
      h("button", { class: "ghost icon", title: "この行を削除", "aria-label": "この行を削除", text: "×", onclick: () => row.remove() }),
    );
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
export function wranglerVarsView(vars, overridden) {
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
          h(
            "tr",
            { class: overridden(k) ? "overridden" : "" },
            h("td", { text: k }),
            h("td", { text: typeof v === "string" ? v : JSON.stringify(v) }),
            h("td", { class: "muted", text: overridden(k) ? "上書き中" : "" }),
          ),
        ),
      ),
    ),
  );
}
