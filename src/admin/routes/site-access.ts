/** サイトのログイン（パスキー）: パスキーの追加と削除。1 つでもあればログインが必須になり、すべて削除するとやめる */
import { randomBytes } from "node:crypto";
import { newSiteAccessSecret, siteRpId, usableOn } from "../../site-auth.ts";
import type { Sites } from "../../sites.ts";
import { type Ctx, fail, type Route, userOf } from "../context.ts";
import { describeDevice, discoverableOf, providerName } from "../passkeys.ts";

const webauthn = () => import("@simplewebauthn/server");

/** パスキーの RP ID（ルートドメイン）。管理画面がそのドメインかサブドメインで開かれていないと登録できない */
function rpIdFor(ctx: Ctx): string {
  const rpId = siteRpId(new URL(ctx.siteRoot).host);
  if (!usableOn(new URL(ctx.origin).host, rpId)) {
    return fail(400, `サイトのログイン用のパスキーは ${rpId} に紐づけます。管理画面を ${rpId} かそのサブドメインで開いてから登録してください`);
  }
  return rpId;
}

/**
 * ユーザーが登録したサイトのパスキーを消す（サイトから外したとき・ユーザーを削除したとき）。
 * 最後の 1 つが消えてもログインはやめない（誰も入れない状態にする）。メンバーが抜けただけで、サイトが誰でも見られるようにならないように
 */
export async function removeSitePasskeysOf(sites: Sites, userId: string, siteNames: Iterable<string>): Promise<void> {
  for (const name of siteNames) {
    if (!sites.has(name) || !sites.settings(name).access?.passkeys.some((p) => p.registeredBy === userId)) continue;
    await sites.updateAccess(name, (current) => current && { ...current, passkeys: current.passkeys.filter((p) => p.registeredBy !== userId) });
  }
}

export const siteAccessRoutes: Route[] = [
  {
    method: "GET",
    path: "/api/sites/:site/access",
    auth: "site",
    handle: (ctx) => {
      const access = ctx.deps.sites.settings(ctx.site.name).access;
      return {
        enabled: Boolean(access),
        passkeys: (access?.passkeys ?? []).map((p) => ({ id: p.id, name: p.name, createdAt: p.createdAt })),
      };
    },
  },
  {
    method: "POST",
    path: "/api/sites/:site/access/register/options",
    auth: "site",
    handle: async (ctx) => {
      const { sites, challenges } = ctx.deps;
      const { name } = ctx.site;
      const rpId = rpIdFor(ctx);
      return (await webauthn()).generateRegistrationOptions({
        rpName: "Kanzume",
        rpID: rpId,
        userName: `${name}（${rpId}）`,
        userDisplayName: `${name} のログイン`,
        userID: randomBytes(16),
        challenge: challenges.create("site-register"),
        attestationType: "none",
        excludeCredentials: (sites.settings(name).access?.passkeys ?? []).map((p) => ({ id: p.id, transports: p.transports as never })),
        authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
      });
    },
  },
  {
    // 最初のパスキーを登録したときに、ログインが必須になる
    method: "POST",
    path: "/api/sites/:site/access/register/verify",
    auth: "site",
    handle: async (ctx) => {
      const { sites, challenges } = ctx.deps;
      const { name } = ctx.site;
      const rpId = rpIdFor(ctx);
      const body = await ctx.body(256 * 1024);
      const attempt = challenges.attempt("site-register");
      let result: Awaited<ReturnType<Awaited<ReturnType<typeof webauthn>>["verifyRegistrationResponse"]>>;
      try {
        result = await (await webauthn()).verifyRegistrationResponse({
          response: body.response as never,
          expectedChallenge: attempt.expected,
          expectedOrigin: ctx.origin,
          expectedRPID: rpId,
          requireUserVerification: false,
        });
      } catch (err) {
        attempt.release();
        return fail(400, (err as Error).message);
      }
      if (!result.verified) {
        attempt.release();
        return fail(400, "パスキーを検証できませんでした");
      }
      attempt.markUsed();
      const { credential, aaguid } = result.registrationInfo!;
      const passkey = {
        id: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString("base64url"),
        counter: credential.counter,
        transports: credential.transports,
        createdAt: new Date().toISOString(),
        name: providerName(aaguid) ?? describeDevice(ctx.req.headers["user-agent"]) ?? "",
        discoverable: discoverableOf(body.response),
        registeredBy: userOf(ctx).id,
      };
      // 同じ ID のパスキーは置き換えずに断る（置き換えると、ほかの人が登録したパスキーの公開鍵を差し替えられる）
      if (sites.settings(name).access?.passkeys.some((p) => p.id === passkey.id)) return fail(400, "このパスキーはすでに登録されています");
      let duplicate = false;
      await sites.updateAccess(name, (current) => {
        duplicate = !!current?.passkeys.some((p) => p.id === passkey.id);
        if (duplicate) return current;
        return { secret: current?.secret ?? newSiteAccessSecret(), passkeys: [...(current?.passkeys ?? []), passkey] };
      });
      if (duplicate) return fail(400, "このパスキーはすでに登録されています");
      return { ok: true };
    },
  },
  {
    method: "DELETE",
    path: "/api/sites/:site/access/passkeys/:id",
    auth: "site",
    handle: async (ctx) => {
      const { sites } = ctx.deps;
      const { name } = ctx.site;
      const access = sites.settings(name).access;
      if (!access?.passkeys.some((p) => p.id === ctx.params.id)) return fail(404, "パスキーが見つかりません");
      // 最後の 1 つを消したらログインをやめる（署名の鍵ごと消し、ログイン中の Cookie も使えなくする）
      await sites.updateAccess(name, (current) => {
        const passkeys = (current?.passkeys ?? []).filter((p) => p.id !== ctx.params.id);
        return current && passkeys.length ? { ...current, passkeys } : undefined;
      });
      return { ok: true };
    },
  },
];
