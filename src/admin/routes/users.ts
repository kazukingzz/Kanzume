/** メンバーの管理（管理者） */
import { fail, type Route, userOf } from "../context.ts";
import { ROOT_SITE_MEMBERS } from "./auth.ts";
import { removeSitePasskeysOf } from "./site-access.ts";

export const userRoutes: Route[] = [
  {
    method: "GET",
    path: "/api/users",
    auth: "admin",
    handle: (ctx) => {
      const { state } = ctx.deps;
      return {
        users: state.users.map((u) => {
          const creds = state.credentialsOf(u.id);
          const used =
            creds
              .map((c) => c.lastUsedAt ?? c.createdAt)
              .sort()
              .at(-1) ?? null;
          return {
            id: u.id,
            name: u.name,
            role: u.role,
            sites: u.sites,
            createdAt: u.createdAt,
            passkeys: creds.length,
            lastUsedAt: used,
            me: u.id === userOf(ctx).id,
          };
        }),
      };
    },
  },
  {
    method: "PUT",
    path: "/api/users/:id",
    auth: "admin",
    handle: async (ctx) => {
      const { state, sites } = ctx.deps;
      const id = ctx.params.id;
      const body = await ctx.body();
      const role = body.role === "admin" || body.role === "member" ? body.role : undefined;
      const target = state.user(id);
      // ルートのサイトに参加しているメンバーは作らない（メンバーにするときも、サイトを足すときも）
      const sitesAfter = [...(target?.sites ?? []), ...(typeof body.addSite === "string" ? [body.addSite] : [])];
      if ((role ?? target?.role) === "member" && sites.root && sitesAfter.includes(sites.root)) return fail(400, ROOT_SITE_MEMBERS);
      const updated = await state.updateUser(id, {
        role,
        name: typeof body.name === "string" ? body.name : undefined,
        removeSite: typeof body.removeSite === "string" ? body.removeSite : undefined,
        addSite: typeof body.addSite === "string" && sites.has(body.addSite) ? body.addSite : undefined,
      });
      // 扱えなくなったサイト（外したサイト・管理者からメンバーにしたときの参加していないサイト）に登録したパスキーを消す
      if (updated.role === "member") {
        await removeSitePasskeysOf(
          sites,
          id,
          sites
            .list()
            .map((s) => s.name)
            .filter((name) => !updated.sites.includes(name)),
        );
      }
      return { user: updated };
    },
  },
  {
    method: "DELETE",
    path: "/api/users/:id",
    auth: "admin",
    handle: async (ctx) => {
      if (ctx.params.id === userOf(ctx).id) return fail(400, "自分は削除できません");
      const { state, sites } = ctx.deps;
      await state.removeUser(ctx.params.id);
      await removeSitePasskeysOf(
        sites,
        ctx.params.id,
        sites.list().map((s) => s.name),
      );
      return { ok: true };
    },
  },
];
