/** ログイン（パスキーの登録・サインイン）・ログアウト・招待リンクの確認 */
import { randomBytes } from "node:crypto";
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import { ADMIN_PATH, type Ctx, fail, reply, type Route } from "../context.ts";
import { describeDevice, providerName } from "../passkeys.ts";
import { type ChallengePurpose, SESSION_COOKIE_MAX_AGE, SESSION_COOKIE } from "../session.ts";
import { normalizeName, safeEqual, type User } from "../state.ts";

export const ROOT_SITE_MEMBERS = "ルートドメインで配信しているサイトには、メンバーを追加できません（管理画面と同じオリジンで動くため）";
const INVALID_INVITE = "招待リンクが無効です（使用済み・期限切れ・取り消し済みのいずれか）";

const sessionCookie = (origin: string, value: string, maxAge: number) =>
  `${SESSION_COOKIE}=${value}; Path=${ADMIN_PATH}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${origin.startsWith("https:") ? "; Secure" : ""}`;

/** セッションを作り、Cookie を付けて返す。管理者なら、このホストを覚える（このホストのラベルをサイトに取らせない） */
async function login(ctx: Ctx, userId: string) {
  const { state } = ctx.deps;
  if (state.user(userId)?.role === "admin") await state.addAdminHost(ctx.rpID);
  return reply(200, { ok: true }, { "set-cookie": sessionCookie(ctx.origin, await state.createSession(userId), SESSION_COOKIE_MAX_AGE) });
}

/**
 * パスキーを登録できるか。誰のパスキーになるかも決める
 * - ログイン中: 自分のパスキーを足す
 * - 初回（パスキーが 1 つもない）: セットアップトークンで最初の管理者
 * - 招待トークン: そのサイトのメンバー（新しいユーザー）
 */
type Registration = { kind: "self"; userId: string } | { kind: "setup" } | { kind: "invite"; token: string };

function allowedToRegister(ctx: Ctx, user: User | null, body: Record<string, unknown>): Registration {
  const { state, config, sites } = ctx.deps;
  if (user) return { kind: "self", userId: user.id };
  if (state.credentials.length === 0) {
    return safeEqual(String(body.setupToken ?? ""), config.setupToken) ? { kind: "setup" } : fail(403, "セットアップトークンが違います");
  }
  if (typeof body.inviteToken === "string" && body.inviteToken) {
    const invite = state.checkInvite(body.inviteToken);
    if (!invite) return fail(403, INVALID_INVITE);
    if (invite.site === sites.root) return fail(403, ROOT_SITE_MEMBERS);
    return { kind: "invite", token: body.inviteToken };
  }
  return fail(403, "パスキーを登録するには、管理者から届いた招待リンクを開いてください");
}

/**
 * パスキーの応答を確かめる。challenge は検証の始めに押さえ（同じ応答を同時に送っても 1 つしか通さない）、
 * 失敗したら外し、成功したら使用済みにする
 */
async function verify<T extends { verified: boolean }>(
  ctx: Ctx,
  purpose: ChallengePurpose,
  run: (expectedChallenge: (c: string) => boolean) => Promise<T>,
): Promise<T> {
  const { challenges } = ctx.deps;
  let challenge = "";
  let result: T;
  try {
    result = await run((c) => {
      challenge = c;
      return challenges.claim(c, purpose);
    });
  } catch (err) {
    challenges.release(challenge);
    return fail(400, (err as Error).message);
  }
  if (!result.verified) {
    challenges.release(challenge);
    return fail(400, "パスキーを検証できませんでした");
  }
  challenges.markUsed(challenge);
  return result;
}

export const authRoutes: Route[] = [
  {
    method: "GET",
    path: "/api/state",
    auth: "public",
    handle: (ctx) => {
      const { state, config } = ctx.deps;
      const authenticated = ctx.user !== null;
      const renew: Record<string, string> = authenticated ? { "set-cookie": sessionCookie(ctx.origin, ctx.sessionId!, SESSION_COOKIE_MAX_AGE) } : {};
      return reply(200, { registered: state.credentials.length > 0, authenticated, domainFromEnv: !!config.origin }, renew);
    },
  },
  {
    method: "POST",
    path: "/api/register/options",
    auth: "public",
    handle: async (ctx) => {
      const { state, challenges } = ctx.deps;
      const body = await ctx.body();
      allowedToRegister(ctx, ctx.user, body);
      return generateRegistrationOptions({
        rpName: "Kanzume",
        rpID: ctx.rpID,
        userName: `Kanzume（${ctx.rpID}）`,
        userDisplayName: ctx.user?.name ?? (normalizeName(body.name) || "Kanzume メンバー"),
        userID: randomBytes(16),
        challenge: challenges.create("register"),
        attestationType: "none",
        // 同じ認証器で別のユーザーとして登録するのは止めない（自分のパスキーの重複だけ防ぐ）
        excludeCredentials: (ctx.user ? state.credentialsOf(ctx.user.id) : []).map((c) => ({ id: c.id, transports: c.transports })),
        authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
      });
    },
  },
  {
    method: "POST",
    path: "/api/register/verify",
    auth: "public",
    handle: async (ctx) => {
      const { state } = ctx.deps;
      const body = await ctx.body(256 * 1024);
      // オプションを取ったあとに招待が使われたなどを防ぐため、もう一度確かめる
      const allowed = allowedToRegister(ctx, ctx.user, body);
      const result = await verify(ctx, "register", (expectedChallenge) =>
        verifyRegistrationResponse({
          response: body.response as never,
          expectedChallenge,
          expectedOrigin: ctx.origin,
          expectedRPID: ctx.rpID,
          requireUserVerification: false,
        }),
      );
      const { credential, aaguid } = result.registrationInfo!;
      const device = describeDevice(ctx.req.headers["user-agent"]);
      let owner: string;
      if (allowed.kind === "self") owner = allowed.userId;
      else if (allowed.kind === "setup") owner = state.setupUserId;
      else {
        const member = await state.redeemInviteAsNewUser(allowed.token, String(body.name ?? ""));
        if (!member) return fail(403, INVALID_INVITE);
        owner = member.id;
      }
      await state.addCredential({
        userId: owner,
        id: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString("base64url"),
        counter: credential.counter,
        transports: credential.transports,
        createdAt: new Date().toISOString(),
        name: providerName(aaguid) ?? device ?? "",
        aaguid,
        device,
      });
      // ログイン中に足したパスキーは、セッションをそのまま使う
      if (allowed.kind === "self") return { ok: true };
      return login(ctx, owner);
    },
  },
  {
    method: "POST",
    path: "/api/login/options",
    auth: "public",
    handle: (ctx) => {
      const { state, challenges } = ctx.deps;
      if (state.credentials.length === 0) return fail(400, "パスキーが未登録です");
      return generateAuthenticationOptions({
        rpID: ctx.rpID,
        challenge: challenges.create("login"),
        allowCredentials: state.credentials.map((c) => ({ id: c.id, transports: c.transports })),
        userVerification: "preferred",
      });
    },
  },
  {
    method: "POST",
    path: "/api/login/verify",
    auth: "public",
    handle: async (ctx) => {
      const { state } = ctx.deps;
      const body = await ctx.body(256 * 1024);
      const response = body.response as { id?: string } | undefined;
      const stored = state.credentials.find((c) => c.id === response?.id);
      if (!stored) return fail(400, "登録されていないパスキーです");
      const result = await verify(ctx, "login", (expectedChallenge) =>
        verifyAuthenticationResponse({
          response: response as never,
          expectedChallenge,
          expectedOrigin: ctx.origin,
          expectedRPID: ctx.rpID,
          credential: {
            id: stored.id,
            publicKey: Buffer.from(stored.publicKey, "base64url"),
            counter: stored.counter,
            transports: stored.transports,
          },
          requireUserVerification: false,
        }),
      );
      await state.updateCounter(stored.id, result.authenticationInfo.newCounter);
      if (!stored.userId || !state.user(stored.userId)) return fail(400, "このパスキーのユーザーは削除されています");
      return login(ctx, stored.userId);
    },
  },
  {
    method: "POST",
    path: "/api/logout",
    auth: "public",
    handle: async (ctx) => {
      try {
        await ctx.deps.state.removeSession(ctx.sessionId);
      } catch (err) {
        console.error("[kanzume] ログアウトの保存に失敗:", err);
        return reply(500, { error: "ログアウトできませんでした。もう一度試してください" });
      }
      return reply(200, { ok: true }, { "set-cookie": sessionCookie(ctx.origin, "", 0) });
    },
  },
  {
    // 招待リンクを開いた人に、どのサイトへの招待かを見せる（ログイン前でも）
    method: "GET",
    path: "/api/invite",
    auth: "public",
    handle: (ctx) => {
      const invite = ctx.deps.state.checkInvite(ctx.query.get("token") ?? "");
      return invite ? { valid: true, site: invite.site, expiresAt: invite.expiresAt } : { valid: false };
    },
  },
];
