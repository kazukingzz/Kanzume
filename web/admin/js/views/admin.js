import { api } from "../core/api.js";
import { fill, h } from "../core/dom.js";
import { fmtAgo, fmtBytes, fmtDate } from "../core/format.js";
import { state } from "../core/state.js";
import { loadOverview, route } from "../shell.js";
import { armed, busy, pageHead } from "../ui/common.js";

export function domainCard() {
  const d = state.overview.domain;
  const input = h("input", {
    value: d.value ?? "",
    placeholder: "example.com",
    spellcheck: "false",
    autocomplete: "off",
    "aria-label": "ルートドメイン",
    disabled: d.fromEnv || undefined,
  });
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
    d.fromEnv
      ? h("p", { class: "muted hint", text: `環境変数 KANZUME_ORIGIN で ${d.effective} に決まっています。変えるには環境変数を変更してください。` })
      : null,
    !d.fromEnv && !d.value ? h("p", { class: "muted hint", text: `今は自動です（この画面を開いている ${d.current} をドメインとして使っています）。` }) : null,
    now && now !== d.current
      ? h("p", { class: "muted hint", text: `この管理画面は ${d.current} で開いています。サイトは ${now} とそのサブドメインで配信されます。` })
      : null,
    error,
  );
}

export function backupCard() {
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
    const restoreText = !restore
      ? "起動時に復元していません（/data にデータがあったか、バックアップがありませんでした）"
      : restore.ok
        ? `世代 ${restore.snapshot} を復元しました（${restore.files} ファイル）`
        : `失敗: ${restore.error}`;
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
        h("p", {
          class: "muted",
          text: "バックアップは無効です。環境変数 KANZUME_BACKUP_URL に S3 互換ストレージ（Cloudflare R2 など）を指定すると、データを外部に保存し、/data が空の状態で起動したときに自動で復元します。",
        }),
        h("code", { class: "value", text: "s3://<ACCESS_KEY_ID>:<SECRET_ACCESS_KEY>@<ACCOUNT_ID>.r2.cloudflarestorage.com/<BUCKET>" }),
      );
    } catch (err) {
      error.textContent = err.message;
    }
  };
  load();
  return h("section", { class: "card" }, h("h2", { text: "バックアップ" }), body, error);
}

/** ルートドメイン（サブドメインなし）で配信するサイトを選ぶ。管理画面と同じオリジンで動くので、管理者だけが決める */
export function rootSiteCard() {
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

/** 管理者設定のメンバー一覧（ロールの変更・サイトから外す・削除） */
export function usersCard() {
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
            const role = h(
              "select",
              { "aria-label": `${u.name} のロール` },
              h("option", { value: "admin", text: "管理者", selected: u.role === "admin" }),
              h("option", { value: "member", text: "メンバー", selected: u.role === "member" }),
            );
            role.addEventListener(
              "change",
              act(() => api(`/users/${encodeURIComponent(u.id)}`, { method: "PUT", body: JSON.stringify({ role: role.value }) })),
            );
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
                          h("button", {
                            class: "tag-remove",
                            title: `${name} から外す`,
                            "aria-label": `${u.name} を ${name} から外す`,
                            text: "×",
                            onclick: act(() => api(`/users/${encodeURIComponent(u.id)}`, { method: "PUT", body: JSON.stringify({ removeSite: name }) })),
                          }),
                        ),
                      ),
                    )
                  : h("span", { class: "muted", text: "参加しているサイトなし" });
            // メンバーに扱えるサイトを足す（招待リンクを使わずに）
            const addable = state.sites.sites.map((x) => x.name).filter((n) => !u.sites.includes(n));
            const attach =
              u.role === "member" && addable.length
                ? (() => {
                    const pick = h(
                      "select",
                      { "aria-label": `${u.name} に足すサイト` },
                      h("option", { value: "", text: "サイトを足す…" }),
                      ...addable.map((n) => h("option", { value: n, text: n })),
                    );
                    pick.addEventListener(
                      "change",
                      () =>
                        pick.value && act(() => api(`/users/${encodeURIComponent(u.id)}`, { method: "PUT", body: JSON.stringify({ addSite: pick.value }) }))(),
                    );
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
              u.me
                ? null
                : armed(
                    h("button", { class: "danger" }),
                    "削除",
                    "もう一度押すと削除",
                    act(() => api(`/users/${encodeURIComponent(u.id)}`, { method: "DELETE" })),
                  ),
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
    h("p", {
      class: "muted",
      text: "メンバーは参加しているサイトだけを扱えます。扱えるサイトは「サイトを足す…」と × で変えられます。新しい人は、各サイトの「サイト設定 > メンバー」で作る招待リンクから参加します。ロールを管理者にすると、全体の設定とすべてのサイトを扱えるようになります。削除するとそのユーザーのパスキーも消えます。",
    }),
    body,
    error,
  );
}

// ---------- 管理者設定 ----------

export async function viewAdmin(main) {
  main.replaceChildren(h("div", { class: "page" }, pageHead("管理者設定"), domainCard(), rootSiteCard(), backupCard(), usersCard()));
}
