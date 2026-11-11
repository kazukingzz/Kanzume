import { api } from "../core/api.js";
import { fill, h, safeUrl } from "../core/dom.js";
import { fmtAgo, fmtBytes, fmtDate, fmtMs } from "../core/format.js";
import { hostOf, siteApi, state } from "../core/state.js";
import { go, loadOverview, siteHash } from "../shell.js";
import { bindingTags, commitLink, kindBanner, loadSite, pageHead, releaseKind, siteUrlCell, statusBadge } from "../ui/common.js";
import { deployOptions } from "./new-site.js";

export async function viewDeployments(main) {
  const [detail, { deployments, active }] = await Promise.all([loadSite(), api(siteApi("/deployments"))]);
  const page = h("div", { class: "page" }, pageHead("デプロイ"));
  if (detail.release) page.append(kindBanner(releaseKind(detail.release)));

  if (!detail.deployed) {
    page.append(
      h(
        "section",
        { class: "card" },
        h("h2", { text: "デプロイ方法を選ぶ" }),
        h("p", {
          class: "muted",
          text: `サイト ${detail.name}（${hostOf(detail.subdomainUrl)}）はまだデプロイされていません。次のどれかの方法でデプロイしてください。`,
        }),
        deployOptions(detail),
      ),
    );
  }

  const latest = detail.latest;
  if (latest && latest.status === "failed" && (!detail.release || latest.id !== detail.release.deployment?.id)) {
    page.append(
      h(
        "div",
        { class: "notice" },
        h("b", { text: `直近のデプロイ（${fmtAgo(latest.createdAt)}）は失敗しました` }),
        h("div", { class: "mono", text: latest.error ?? "" }),
      ),
    );
  }

  const current = h(
    "section",
    { class: "card" },
    h(
      "div",
      { class: "card-head" },
      h("h2", { text: "現在のデプロイ" }),
      detail.release ? h("span", { class: "status good", text: "アクティブ" }) : h("span", { class: "status neutral", text: "未公開" }),
    ),
  );
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
      safeUrl(s.runUrl) ? ["Actions", h("a", { href: safeUrl(s.runUrl), target: "_blank", rel: "noopener", text: "実行ログを開く ↗" })] : null,
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
          h(
            "span",
            { class: "grow" },
            h("b", { text: "新しくデプロイ" }),
            h("span", { class: "muted", text: "別の方法でデプロイして、今のリリースを置き換えます" }),
          ),
          chevron,
        ),
        deployOptions(detail),
      ),
    );
  }
  main.replaceChildren(page);
}

export async function deployGitHub(body, onError) {
  let site;
  try {
    try {
      ({ site } = await api("/deploy-github", { method: "POST", body: JSON.stringify(body) }));
    } catch (err) {
      // 公開中のリリースがあるサイト（サーバーが exists を付けて 409 を返す）は、確かめてから置き換える
      if (
        !err.data?.exists ||
        !confirm(`サイト ${body.name} には公開中のリリースがあります。新しくデプロイして置き換えますか？\n（KV / R2 のデータは残ります）`)
      )
        throw err;
      ({ site } = await api("/deploy-github", { method: "POST", body: JSON.stringify({ ...body, confirm: true }) }));
    }
  } catch (err) {
    onError(err.message);
    return;
  }
  await afterDeploy(site);
}

/** デプロイが終わったら、一覧を読み直してデプロイタブを開く */
export async function afterDeploy(site) {
  // デプロイは成功しているので、一覧の再読み込みに失敗してもエラーにしない
  await loadOverview().catch(() => {});
  // 同じサイトのデプロイタブからデプロイしたときは hashchange が起きないので、go が描き直す
  go(siteHash("deployments", site));
}

export function deploymentItem(d, isActive) {
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
              safeUrl(s.runUrl) ? h("a", { href: safeUrl(s.runUrl), target: "_blank", rel: "noopener", text: "GitHub Actions の実行ログを開く ↗" }) : null,
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
