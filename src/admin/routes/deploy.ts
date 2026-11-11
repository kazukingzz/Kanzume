/** 管理画面からのデプロイ: GitHub の公開リポジトリから・ファイルのアップロードから */
import { deployFromFiles } from "../../deploy/build.ts";
import { DeployLog } from "../../deploy/deployer.ts";
import { deployFromGitHub, fetchFromGitHub, inspectFiles } from "../../deploy/github.ts";
import { extractTarGz } from "../../deploy/tar.ts";
import { CONFIG_FILES } from "../../deploy/wrangler.ts";
import { mib, tooLarge } from "../../errors.ts";
import type { PendingCommit } from "../../git/repos.ts";
import { readBody } from "../../http.ts";
import { normalizeSiteName, siteNotFound, type SiteSettings } from "../../sites.ts";
import { type Ctx, fail, forbidden, reply, type Route, str, userOf } from "../context.ts";
import { envPatch } from "./sites.ts";

const githubOptions = (ctx: Ctx) => ({ maxBytes: ctx.deps.config.maxUploadBytes, ...ctx.deps.github });

/** GitHub の URL からデプロイする。環境変数を一緒に変えるときは、失敗したら元に戻す */
async function deployGitHub(ctx: Ctx) {
  const { sites, runtime, deployer } = ctx.deps;
  const body = await ctx.body();
  const url = str(body.url);
  if (!url) return fail(400, "GitHub の URL を入力してください");
  // デプロイ先は管理画面で追加済みのサイトだけ（wrangler の name は使わない）
  const siteName = normalizeSiteName(body.name);
  if (!siteName) return fail(400, "デプロイ先のサイトを指定してください");
  if (!ctx.canSite(siteName)) return forbidden();
  if (!sites.has(siteName)) throw siteNotFound(siteName);
  if (sites.deployed(siteName) && body.confirm !== true)
    return reply(409, { error: `サイト ${siteName} は既にあります。上書きしてデプロイしますか？`, exists: true });
  const patch = envPatch(body);
  const evict = () => {
    const store = sites.get(siteName);
    if (store) runtime.evict(store.siteDir);
  };

  // ダウンロードと展開は本体で 1 つずつ。同じサイトのほかのデプロイ（git push・アップロード）とも 1 つずつ
  return deployer.intake(() =>
    deployer.exclusive(siteName, async () => {
      // 失敗したときに戻す、デプロイ前の設定（今動いているリリースは、この設定のまま動かし続ける）
      let before: SiteSettings | null = null;
      const rollback = async () => {
        if (!before) return;
        await sites.restoreSettings(siteName, before);
        evict();
      };
      try {
        if (patch.vars || patch.secrets) {
          // 最初に読み込む Worker から新しい環境変数を使うように、デプロイの前に設定を書く
          before = sites.settings(siteName);
          await sites.updateSettings(siteName, patch);
          evict();
        }
        // メンバーのサイトを自動でルートにしない（ルートは管理画面と同じオリジンで動くため）
        const result = await deployFromGitHub(url, deployer, { ...githubOptions(ctx), siteName, autoRoot: ctx.isAdmin });
        if (!result.ok) {
          await rollback();
          return fail(400, result.error);
        }
        return { site: siteName, release: result.release.id, url: sites.urls(ctx.siteRoot, siteName).url };
      } catch (err) {
        await rollback().catch(() => {});
        throw err;
      }
    }),
  );
}

/**
 * ファイルのドラッグ＆ドロップでデプロイする（本文は管理画面で作った tar.gz）。
 * wrangler の設定があればそれに従い、なければ全体を静的サイトとして配信する。サイトのリポジトリのコミットにもする
 */
async function upload(ctx: Ctx) {
  const { config, repos, deployer, sites } = ctx.deps;
  const { name } = ctx.site;
  const user = userOf(ctx);
  // 本文の受け取りと展開は本体で 1 つずつ（展開したファイルとビルドでメモリを多く使うため）
  return deployer.intake(async () => {
    const body = await readBody(ctx.req, config.maxUploadBytes);
    if (!body) throw tooLarge(config.maxUploadBytes);
    let files = extractTarGz(body, config.maxUploadBytes, { skipLinks: true });
    if (!files.length) return fail(400, "ファイルがありません");
    // 設定ファイルの有無だけを見る（どれを使うかはデプロイと同じく CONFIG_FILES の順で決まる）。
    // name はそのままでよい（デプロイ先は、このサイト）
    const hasConfig = files.some((f) => (CONFIG_FILES as readonly string[]).includes(f.path));
    const count = files.length;
    if (!hasConfig) {
      const today = new Date().toISOString().slice(0, 10);
      files = [
        { path: "wrangler.jsonc", data: Buffer.from(`${JSON.stringify({ name, compatibility_date: today, assets: { directory: "./public" } }, null, 2)}\n`) },
        ...files.map((f) => ({ path: `public/${f.path}`, data: f.data })),
      ];
    }
    const uploaded = files;
    // 同じサイトの git push とは 1 つずつ（コミット → デプロイ → ブランチを進める、の間に push を挟まない）
    return deployer.exclusive(name, async () => {
      const message = `ファイルをアップロード（${count} ファイル${hasConfig ? "" : "・静的サイト"}）`;
      // 手元にファイルがなくなっても clone で取り出せるように、サイトのリポジトリのコミットにする。
      // 取り込むのはデプロイに成功してから（リポジトリの先頭と動いているものをそろえる）
      let commit: PendingCommit | null = null;
      let repoWarning: string | null = null;
      const notSaved = "デプロイはしましたが、リポジトリに保存できませんでした";
      try {
        commit = await repos.commitFiles(name, uploaded, { message, author: user.name, email: `${user.id}@users.kanzume` });
      } catch (err) {
        console.error("[upload] リポジトリへのコミットに失敗:", err);
        repoWarning = notSaved;
      }
      const source = commit
        ? { repository: name, ref: commit.branch, sha: commit.sha, commitMessage: message, actor: user.name }
        : { actor: user.name, commitMessage: message };
      const discard = async () => {
        if (commit) await repos.discardCommit(commit).catch(() => {});
      };
      const result = await deployFromFiles(uploaded, deployer, {
        source,
        log: new DeployLog(name),
        buildLog: [],
        where: "アップロードしたファイルのトップ",
        siteName: name,
        // メンバーのサイトを自動でルートにしない（ルートは管理画面と同じオリジンで動くため）
        autoRoot: ctx.isAdmin,
      }).catch(async (err: unknown) => {
        await discard();
        throw err;
      });
      if (!result.ok) {
        // 取り込まない（このアップロードのために作ったリポジトリも消す）
        await discard();
        return fail(400, result.error);
      }
      if (commit) {
        // 公開はもう済んでいるので、リポジトリへの取り込みに失敗しても警告にとどめる
        const moved = await repos.updateBranch(commit).catch((err) => {
          console.error("[upload] リポジトリへの取り込みに失敗:", err);
          return "error" as const;
        });
        if (moved === "error") repoWarning = notSaved;
        else if (moved === "quota") repoWarning = `デプロイはしましたが、リポジトリの容量の上限（${mib(repos.quotaBytes)}）を超えるので保存しませんでした`;
        else if (moved === "moved") repoWarning = "デプロイはしましたが、その間にリポジトリに push があったので保存しませんでした";
      }
      return {
        site: name,
        release: result.release.id,
        url: sites.urls(ctx.siteRoot, name).url,
        static: !hasConfig,
        commit: repoWarning ? null : (commit?.sha ?? null),
        repoWarning,
      };
    });
  });
}

export const deployRoutes: Route[] = [
  { method: "POST", path: "/api/deploy-github", auth: "user", handle: deployGitHub },
  {
    // デプロイ前の設定画面: 取得したリポジトリの wrangler の設定（vars）だけを返す（ほかのサイトの情報は混ぜない）
    method: "POST",
    path: "/api/deploy-github/inspect",
    auth: "user",
    handle: async (ctx) => {
      const url = str((await ctx.body()).url);
      if (!url) return fail(400, "GitHub の URL を入力してください");
      // サイトを扱えないユーザー（参加しているサイトのないメンバー）には使わせない
      if (!ctx.isAdmin && userOf(ctx).sites.length === 0) return forbidden();
      return ctx.deps.deployer.intake(async () => inspectFiles(await fetchFromGitHub(url, githubOptions(ctx), new DeployLog("inspect"))));
    },
  },
  { method: "POST", path: "/api/sites/:site/deploy-upload", auth: "site", handle: upload },
];
