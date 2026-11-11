import { api } from "../core/api.js";
import { fill, h } from "../core/dom.js";
import { fmtBytes } from "../core/format.js";
import { siteApi, state } from "../core/state.js";
import { droppedFiles, prepareUpload, tarGz, uploadPlan } from "../deploy/upload.js";
import { go, loadOverview, siteHash } from "../shell.js";
import { busy, copyButton, kindBadge, pageHead } from "../ui/common.js";
import { afterDeploy, deployGitHub, deploymentItem } from "./deployments.js";
import { envEditor, subdomainInput } from "./site.js";

// ---------- 設定 ----------

/** GitHub Actions のワークフロー。デプロイ先は site（管理画面で追加したサイト）で決まる（wrangler の name は使わない） */
export const workflow = (url, site) => `name: Deploy to Kanzume
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

/** デプロイ前の設定カード（GitHub の URL・サンプル） */
/**
 * GitHub の URL を読んだあとの確認カード。デプロイ先は作成済みのサイト（site）で、環境変数とシークレットを決めてからデプロイする。
 * cfg: inspect の結果（wrangler の vars）と、そのサイトの今の設定（current）
 */
export function deployConfigCard(cfg, site, onBack) {
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
    h(
      "section",
      { class: "card" },
      h("h2", { text: "リポジトリ" }),
      h("code", { class: "value", text: cfg.repoUrl }),
      h("p", { class: "muted hint", text: `サイト ${site} にデプロイします。` }),
    ),
    h(
      "section",
      { class: "card" },
      h("h2", { text: "環境変数" }),
      h("p", {
        class: "muted",
        text: "Worker の env（nodejs_compat なら process.env も）に入ります。wrangler の設定の vars を初期値にしています。デプロイしたあとも「サイト設定」で変えられます。",
      }),
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

export async function viewNewSite(main) {
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
      h("p", {
        class: "muted",
        text: "サイトを作ると、次にデプロイの方法（サンプル・GitHub の公開リポジトリ・GitHub Actions・Kanzume のリポジトリ）を選べます。",
      }),
      h("div", { class: "row narrow" }, h("div", { class: "grow" }, sub.el), create),
      status,
      error,
    ),
  );
  const pending = state.sites.pending;
  if (pending.length) {
    page.append(
      h("div", { class: "section-head" }, h("h2", { text: "公開に至らなかったデプロイ" }), h("span", { class: "muted", text: `${pending.length} 件` })),
    );
    const list = h("div", { class: "list" });
    for (const d of pending) list.append(deploymentItem(d, false));
    page.append(list);
  }
  main.replaceChildren(page);
  // 画面に入れてからでないとフォーカスできない
  sub.input.focus();
}

// ---------- デプロイ方法（サイトごと） ----------

export const DEPLOY_METHODS = [
  { key: "upload", title: "ファイルから", description: "フォルダ・ファイル・zip をドラッグ＆ドロップしてデプロイします。" },
  { key: "github", title: "GitHub の公開リポジトリから", description: "public リポジトリの URL を指定して、Kanzume の中でバンドルしてデプロイします。" },
  { key: "actions", title: "GitHub Actions から", description: "push のたびに Actions でビルドしてデプロイします。npm パッケージやビルドが必要なときに。" },
  { key: "repo", title: "サイトのリポジトリから", description: "Kanzume にこのサイトの Git リポジトリを作り、git push でデプロイします。GitHub は不要です。" },
];

/** サイトにデプロイする 4 つの方法。選んだ方法の中身を下に出す */
export function deployOptions(detail) {
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
      const b = h(
        "button",
        { class: "deploy-method", "data-key": m.key, onclick: () => choose(m.key) },
        h("b", { text: m.title }),
        h("span", { class: "muted", text: m.description }),
      );
      buttons.push(b);
      return b;
    }),
  );
  return h("div", {}, grid, panel);
}

export const METHOD_VIEWS = {
  async upload(detail) {
    const error = h("div", { class: "error" });
    const summary = h("div");
    const fileInput = h("input", { type: "file", multiple: true, hidden: true });
    const dirInput = h("input", { type: "file", webkitdirectory: true, hidden: true });
    const zone = h(
      "div",
      { class: "dropzone", tabindex: "0", role: "button", "aria-label": "フォルダ・ファイル・zip を選ぶ" },
      h("span", {
        class: "dropzone-icon",
        html: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>',
      }),
      // タッチの端末ではドラッグできないので、選ぶ案内にする
      h("b", { text: matchMedia("(hover: none)").matches ? "タップしてファイル・zip を選ぶ" : "ここにフォルダ・ファイル・zip をドロップ" }),
      h(
        "span",
        { class: "muted" },
        "または ",
        h("button", {
          type: "button",
          class: "link",
          text: "ファイルを選ぶ",
          onclick: (e) => {
            e.stopPropagation();
            fileInput.click();
          },
        }),
        "・",
        h("button", {
          type: "button",
          class: "link",
          text: "フォルダを選ぶ",
          onclick: (e) => {
            e.stopPropagation();
            dirInput.click();
          },
        }),
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
      const again = h("button", {
        text: "選び直す",
        onclick: () => {
          fill(summary);
          error.textContent = "";
        },
      });
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
            h("b", {
              text: plan.config
                ? `${plan.config} の設定でデプロイします${plan.worker ? "（Worker あり）" : ""}`
                : "設定ファイルがないので、静的サイトとしてデプロイします",
            }),
          ),
          h("p", { class: "muted", text: `${files.length} ファイル・${fmtBytes(size)}` }),
          !plan.config && !plan.index ? h("p", { class: "warn", text: "トップに index.html がありません。/ を開くと 404 になります。" }) : null,
          h(
            "ul",
            { class: "upload-files mono" },
            ...shown.map((f) => h("li", {}, h("span", { text: f.path }), h("span", { class: "muted", text: fmtBytes(f.file.size) }))),
            files.length > shown.length ? h("li", { class: "muted", text: `ほか ${files.length - shown.length} ファイル` }) : null,
          ),
          h("div", { class: "actions" }, deploy, again),
        ),
      );
    };

    return [
      h(
        "section",
        { class: "card" },
        h("h2", { text: "ファイルから" }),
        h("p", {
          class: "muted",
          text: `ビルドしたフォルダやファイルを ${detail.name} にデプロイします。wrangler.jsonc / wrangler.toml があればその設定に従い（Worker はここでバンドルします）、なければ全体を静的サイトとして配信します。`,
        }),
        h("p", {
          class: "muted",
          text: `デプロイしたファイルは、このサイトのリポジトリ（リポジトリタブ）にコミットとして保存します。手元にファイルがなくなっても git clone で取り出せます。`,
        }),
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
    const input = h("input", {
      type: "url",
      placeholder: "https://github.com/<owner>/<repo>/tree/<branch>/<dir>",
      spellcheck: "false",
      "aria-label": "GitHub の URL",
    });
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
        const [info, settings] = await Promise.all([
          api("/deploy-github/inspect", { method: "POST", body: JSON.stringify({ url }) }),
          api(`/sites/${encodeURIComponent(detail.name)}/settings`),
        ]);
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
      h("p", {
        class: "muted",
        text: "wrangler の設定があるディレクトリの URL を入力してください。次の画面で環境変数とシークレットを確かめてからデプロイします。npm パッケージに依存するコードや、ビルドが必要なアセットは GitHub Actions を使ってください。",
      }),
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
          h(
            "li",
            {},
            "「",
            h("a", { href: "#/settings", text: "設定 > トークン" }),
            "」で個人トークンを発行し、GitHub のリポジトリの Secrets に KANZUME_TOKEN として登録します。",
          ),
          h("li", { text: `次のワークフローを置いて push します。デプロイ先は site のサイト（${detail.name}）で、wrangler の name は使いません。` }),
        ),
        h(
          "div",
          { class: "card-head" },
          h("span", { class: "mono", text: ".github/workflows/deploy.yml" }),
          copyButton(() => workflow(state.overview.url, detail.name)),
        ),
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
          h("p", {
            class: "muted",
            text: `Kanzume に Git リポジトリ ${site} を作ります。main に push すると、wrangler の設定どおりにこのサイトへデプロイします。`,
          }),
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
