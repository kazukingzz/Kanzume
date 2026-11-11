import { api } from "../core/api.js";
import { fill, h } from "../core/dom.js";
import { fmtDate } from "../core/format.js";
import { state } from "../core/state.js";
import { go, loadOverview, siteHash } from "../shell.js";
import { armed, copyButton, loadSite, pageHead } from "../ui/common.js";
import { buildTree, renderFile } from "./code.js";
import { METHOD_VIEWS } from "./new-site.js";

export async function viewRepo(main, name) {
  const repo = await api(`/repos/${encodeURIComponent(name)}`);
  const repoApi = (path) => `/repos/${encodeURIComponent(name)}${path}`;
  const page = h("div", { class: "page" });
  page.append(h("div", { class: "page-head" }, h("h1", { text: "リポジトリ" })));

  const commands = `git remote add origin ${repo.cloneUrl}\ngit push -u origin ${repo.defaultBranch}`;
  page.append(
    h(
      "section",
      { class: "card" },
      h("h2", { text: "push してデプロイ" }),
      h(
        "div",
        { class: "field" },
        h("label", { text: "URL" }),
        h(
          "div",
          { class: "row" },
          h("code", { class: "value grow", text: repo.cloneUrl }),
          copyButton(() => repo.cloneUrl),
        ),
      ),
      h(
        "div",
        { class: "card-head" },
        h("span", { class: "muted", text: "手元のリポジトリで" }),
        copyButton(() => commands),
      ),
      h("pre", { class: "log", text: commands }),
      h(
        "p",
        { class: "muted hint" },
        "すでに origin がある（GitHub から clone した）リポジトリでは、1 行目の代わりに ",
        h("code", { text: `git remote set-url origin ${repo.cloneUrl}` }),
        " で付け替えるか、",
        h("code", { text: "origin" }),
        " を別の名前（例: ",
        h("code", { text: "kanzume" }),
        "）にしてください。",
      ),
      h(
        "p",
        { class: "muted hint" },
        "ユーザー名は何でもよく、パスワードには「",
        h("a", { href: "#/settings", text: "設定 > トークン" }),
        `」で発行した個人トークンを入力します。${repo.defaultBranch} 以外のブランチへの push は保存だけしてデプロイしません。デフォルトブランチは削除できません。npm パッケージの import やビルドが必要なものは GitHub Actions を使ってください。`,
      ),
    ),
  );

  // 中身（ブランチ・コミット・ファイル）
  if (repo.refs.length) {
    const branch = h("select", { "aria-label": "ブランチ" }, ...repo.refs.map((r) => h("option", { value: r.branch, text: r.branch })));
    const remembered = state.repoRefs[name];
    const current = repo.refs.some((r) => r.branch === remembered) ? remembered : repo.defaultBranch;
    branch.value = repo.refs.some((r) => r.branch === current) ? current : repo.refs[0].branch;
    const commits = h("div", { class: "list repo-commits" });
    const tree = h("nav", { class: "tree" });
    const mobile = h("select", { class: "mobile-file", "aria-label": "ファイル" });
    const viewer = h("div", { class: "viewer" });
    let selected = null;
    const showRepoFile = async (path, buttons) => {
      selected = path;
      for (const b of buttons) b.classList.toggle("current", b.dataset.path === path);
      mobile.value = path;
      viewer.replaceChildren(
        h("div", { class: "viewer-head" }, h("span", { class: "path", text: path })),
        h("div", { class: "placeholder", text: "読み込み中…" }),
      );
      const ref = branch.value;
      const file = await api(repoApi(`/blob?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}`)).catch((err) => ({ error: err.message }));
      // 待っている間に別のファイルやブランチに切り替わっていたら捨てる
      if (selected === path && branch.value === ref) renderFile(viewer, path, file);
    };
    let loading = 0;
    const load = async () => {
      state.repoRefs[name] = branch.value;
      const ticket = ++loading;
      const ref = encodeURIComponent(branch.value);
      const [{ commits: log }, { files }] = await Promise.all([api(repoApi(`/log?ref=${ref}`)), api(repoApi(`/tree?ref=${ref}`))]);
      // ブランチを続けて切り替えたとき、古い応答で上書きしない
      if (ticket !== loading) return;
      fill(
        commits,
        ...log.map((c) =>
          h(
            "div",
            { class: "list-item" },
            h(
              "div",
              { class: "list-row static" },
              h("span", { class: "mono sha", text: c.sha.slice(0, 7) }),
              h("div", { class: "grow" }, h("div", { class: "title", text: c.subject }), h("div", { class: "sub", text: `${c.author} · ${fmtDate(c.date)}` })),
            ),
          ),
        ),
      );
      const buttons = [];
      const renderNode = (node, depth) => {
        const out = [];
        for (const [dir, child] of [...node.dirs].sort(([a], [b]) => a.localeCompare(b))) {
          const details = h("details", { open: depth < 1 || undefined });
          const summary = h("summary", { text: dir });
          summary.style.paddingLeft = `${14 + depth * 12}px`;
          details.append(summary, ...renderNode(child, depth + 1));
          out.push(details);
        }
        for (const f of node.files) {
          const b = h("button", { class: "file", title: f.path, "data-path": f.path, text: f.name, onclick: () => showRepoFile(f.path, buttons) });
          b.style.paddingLeft = `${14 + depth * 12}px`;
          buttons.push(b);
          out.push(b);
        }
        return out;
      };
      fill(tree, ...renderNode(buildTree(files), 0));
      fill(mobile, ...files.map((f) => h("option", { value: f.path, text: f.path })));
      const first = files.find((f) => /^wrangler\.(jsonc|json|toml)$/.test(f.path)) ?? files.find((f) => /readme/i.test(f.path)) ?? files[0];
      if (first) showRepoFile(first.path, buttons);
      else viewer.replaceChildren(h("div", { class: "placeholder", text: "ファイルがありません" }));
    };
    branch.addEventListener("change", () => load().catch((err) => fill(commits, h("div", { class: "notice", text: err.message }))));
    mobile.addEventListener("change", () => showRepoFile(mobile.value, [...tree.querySelectorAll(".file")]));
    page.append(
      h("div", { class: "section-head" }, h("h2", { text: "ファイル" }), h("label", { class: "inline" }, "ブランチ ", branch)),
      mobile,
      h("div", { class: "code-layout repo-code" }, tree, viewer),
      h("div", { class: "section-head" }, h("h2", { text: "コミット" }), h("span", { class: "muted", text: "直近 50 件" })),
      commits,
    );
    await load();
  } else {
    page.append(
      h("section", { class: "card empty" }, h("p", { text: "まだ push されていません。上のコマンドで push すると、ここにファイルとコミットが出ます。" })),
    );
  }

  const delError = h("div", { class: "error" });
  page.append(
    h(
      "section",
      { class: "card" },
      h("h2", { text: "リポジトリの削除" }),
      h("p", { class: "muted", text: "リポジトリを削除します。サイトとデプロイ済みのリリースは残ります。" }),
      armed(h("button", { class: "danger" }), "リポジトリを削除", "もう一度押すと削除", async () => {
        try {
          await api(repoApi(""), { method: "DELETE" });
          await loadOverview();
          go(siteHash("deployments", name));
        } catch (err) {
          delError.textContent = err.message;
        }
      }),
      delError,
    ),
  );
  main.replaceChildren(page);
}

/** サイトのリポジトリのタブ。まだなければ作成のボタンを出す */
export async function viewRepoTab(main) {
  const detail = await loadSite();
  if (detail.repo) return viewRepo(main, detail.name);
  const page = h("div", { class: "page" }, pageHead("リポジトリ"), ...(await METHOD_VIEWS.repo(detail)));
  main.replaceChildren(page);
}
