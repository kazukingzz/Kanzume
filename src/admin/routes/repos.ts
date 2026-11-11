/** サイトの Git リポジトリ（リポジトリはサイトに属し、push するとそのサイトにデプロイする） */
import { GIT_PATH } from "../../git/server.ts";
import { normalizeSiteName } from "../../sites.ts";
import { type Ctx, fail, forbidden, type Route } from "../context.ts";

const cloneUrl = (ctx: Ctx, name: string) => `${ctx.origin}${GIT_PATH}/${name}.git`;

async function repoInfo(ctx: Ctx, name: string) {
  const { repos, sites } = ctx.deps;
  return { ...(await repos.summary(name)), cloneUrl: cloneUrl(ctx, name), site: sites.get(name)?.get() ? name : null };
}

/** パスの :repo を扱えるか（リポジトリと同じ名前のサイトを扱えるユーザー）と、あるかを確かめる */
async function repoOf(ctx: Ctx): Promise<string> {
  const name = ctx.params.repo;
  if (!ctx.canSite(name)) return forbidden();
  if (!(await ctx.deps.repos.exists(name))) return fail(404, "リポジトリが見つかりません");
  return name;
}

const refOf = async (ctx: Ctx, name: string) => ctx.query.get("ref") || (await ctx.deps.repos.defaultBranch(name));

export const repoRoutes: Route[] = [
  {
    method: "GET",
    path: "/api/repos",
    auth: "user",
    handle: async (ctx) => {
      const { repos } = ctx.deps;
      // 1 つ読めないリポジトリがあっても、一覧全体は返す
      const list = await Promise.all(
        (await repos.names())
          .filter((n) => ctx.canSite(n))
          .map((name) =>
            repoInfo(ctx, name).catch((err) => {
              console.error(`[git] リポジトリ ${name} を読めません:`, err);
              return { name, broken: true, cloneUrl: cloneUrl(ctx, name), site: null, defaultBranch: "main", lastPush: null, size: 0 };
            }),
          ),
      );
      return { repos: list };
    },
  },
  {
    method: "POST",
    path: "/api/repos",
    auth: "user",
    handle: async (ctx) => {
      const name = normalizeSiteName((await ctx.body()).name);
      // メンバーは、自分のサイトと同じ名前のリポジトリだけ作れる
      if (!ctx.canSite(name)) return forbidden();
      await ctx.deps.repos.create(name);
      return repoInfo(ctx, name);
    },
  },
  {
    method: "GET",
    path: "/api/repos/:repo",
    auth: "user",
    handle: async (ctx) => {
      const name = await repoOf(ctx);
      return { ...(await repoInfo(ctx, name)), refs: await ctx.deps.repos.refs(name) };
    },
  },
  {
    method: "DELETE",
    path: "/api/repos/:repo",
    auth: "user",
    handle: async (ctx) => {
      await ctx.deps.repos.remove(await repoOf(ctx));
      return { ok: true };
    },
  },
  {
    method: "GET",
    path: "/api/repos/:repo/log",
    auth: "user",
    handle: async (ctx) => {
      const name = await repoOf(ctx);
      const ref = await refOf(ctx, name);
      return { ref, commits: await ctx.deps.repos.log(name, ref) };
    },
  },
  {
    method: "GET",
    path: "/api/repos/:repo/tree",
    auth: "user",
    handle: async (ctx) => {
      const name = await repoOf(ctx);
      const ref = await refOf(ctx, name);
      return { ref, files: await ctx.deps.repos.tree(name, ref) };
    },
  },
  {
    method: "GET",
    path: "/api/repos/:repo/blob",
    auth: "user",
    handle: async (ctx) => {
      const name = await repoOf(ctx);
      const blob = await ctx.deps.repos.blob(name, await refOf(ctx, name), ctx.query.get("path") ?? "");
      return blob ?? fail(404, "ファイルが見つかりません");
    },
  },
];
