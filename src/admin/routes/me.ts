/** ログインしている人の情報と個人の設定（パスキー・名前・個人トークン・招待の受け入れ） */
import { configuredRootHost } from "../../http.ts";
import { fail, type Route, userOf } from "../context.ts";
import { providerName } from "../passkeys.ts";
import { normalizeName } from "../state.ts";
import { ROOT_SITE_MEMBERS } from "./auth.ts";

export const meRoutes: Route[] = [
  {
    method: "GET",
    path: "/api/overview",
    auth: "user",
    handle: async (ctx) => {
      const { state, config } = ctx.deps;
      const user = userOf(ctx);
      // パスキーを使っている管理画面のホストを覚える（このホストのラベルをサイトに取らせない）
      if (ctx.isAdmin) await state.addAdminHost(ctx.rpID);
      const current = new URL(ctx.origin).host;
      return {
        url: ctx.origin,
        me: { id: user.id, name: user.name, role: user.role, sites: user.sites },
        maxUploadBytes: config.maxUploadBytes,
        members: state.users.length,
        domain: {
          value: state.domain,
          fromEnv: Boolean(config.origin),
          effective: configuredRootHost(config.origin, state.domain) ?? current,
          current,
        },
      };
    },
  },
  {
    method: "GET",
    path: "/api/passkeys",
    auth: "user",
    handle: (ctx) => ({
      passkeys: ctx.deps.state.credentialsOf(userOf(ctx).id).map((c) => ({
        id: c.id,
        name: c.name ?? "",
        provider: providerName(c.aaguid) ?? null,
        device: c.device ?? null,
        createdAt: c.createdAt,
        lastUsedAt: c.lastUsedAt ?? null,
      })),
    }),
  },
  {
    method: "POST",
    path: "/api/passkeys/rename",
    auth: "user",
    handle: async (ctx) => {
      const { state } = ctx.deps;
      const body = await ctx.body();
      const name = normalizeName(body.name);
      if (!name) return fail(400, "名前を入力してください");
      const id = String(body.id ?? "");
      if (!state.credentialsOf(userOf(ctx).id).some((c) => c.id === id)) return fail(404, "パスキーが見つかりません");
      return (await state.renameCredential(id, name)) ? { name } : fail(404, "パスキーが見つかりません");
    },
  },
  {
    method: "DELETE",
    path: "/api/passkeys/:id",
    auth: "user",
    handle: async (ctx) => {
      await ctx.deps.state.removeCredential(ctx.params.id, userOf(ctx).id);
      return { ok: true };
    },
  },
  {
    method: "PUT",
    path: "/api/me",
    auth: "user",
    handle: async (ctx) => {
      const body = await ctx.body();
      const updated = await ctx.deps.state.updateUser(userOf(ctx).id, { name: String(body.name ?? "") });
      return { name: updated.name };
    },
  },
  {
    // 個人トークン（git push と GitHub Actions に使う。扱えるサイトは自分と同じ）
    method: "GET",
    path: "/api/tokens",
    auth: "user",
    handle: (ctx) => ({
      tokens: ctx.deps.state.userTokens(userOf(ctx).id).map((t) => ({ id: t.id, name: t.name, createdAt: t.createdAt, expiresAt: t.expiresAt })),
    }),
  },
  {
    method: "POST",
    path: "/api/tokens",
    auth: "user",
    handle: async (ctx) => {
      const body = await ctx.body();
      const ttl = body.ttl === null || body.ttl === undefined ? null : Number(body.ttl);
      if (ttl !== null && !(ttl > 0 && ttl <= 365 * 86400)) return fail(400, "期限が不正です");
      const { token, info } = await ctx.deps.state.createUserToken(userOf(ctx).id, String(body.name ?? ""), ttl);
      return { token, id: info.id, name: info.name, createdAt: info.createdAt, expiresAt: info.expiresAt };
    },
  },
  {
    method: "DELETE",
    path: "/api/tokens/:id",
    auth: "user",
    handle: async (ctx) => ((await ctx.deps.state.revokeUserToken(userOf(ctx).id, ctx.params.id)) ? { ok: true } : fail(404, "トークンが見つかりません")),
  },
  {
    // ログイン中に招待リンクを開いたとき: 自分をそのサイトのメンバーにする
    method: "POST",
    path: "/api/invite/accept",
    auth: "user",
    handle: async (ctx) => {
      const { state, sites } = ctx.deps;
      const body = await ctx.body();
      const token = String(body.token ?? "");
      if (state.checkInvite(token)?.site === sites.root && !ctx.isAdmin) return fail(400, ROOT_SITE_MEMBERS);
      const invite = await state.consumeInvite(token, userOf(ctx).id);
      if (!invite) return fail(400, "招待リンクが無効です（使用済み・期限切れ・取り消し済みのいずれか）");
      return { site: invite.site };
    },
  },
];
