import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/**
 * 管理画面のセッションの Cookie。https では __Host- を付ける（Domain を付けられないので、兄弟のサブドメインの Worker が
 * Domain=<ルートドメイン> で同じ名前の Cookie を置いて、管理者のセッションを差し替えられない）。
 * __Host- は Secure が要るので、http（手元の開発）では付けない
 */
export const SESSION_COOKIE = "kanzume_session";
export const HOST_SESSION_COOKIE = `__Host-${SESSION_COOKIE}`;
// Cookie を無期限にしないのは、ブラウザが Max-Age を最長 400 日に切り詰めるため
export const SESSION_COOKIE_MAX_AGE = 400 * 24 * 60 * 60;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export const sessionCookieName = (origin: string) => (origin.startsWith("https:") ? HOST_SESSION_COOKIE : SESSION_COOKIE);

/** 同じ名前の Cookie の値をすべて（親ドメインに付けた同名の Cookie があっても、本物を見落とさない） */
export function readCookies(req: IncomingMessage, name: string): string[] {
  const out: string[] = [];
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1 || part.slice(0, eq).trim() !== name) continue;
    try {
      out.push(decodeURIComponent(part.slice(eq + 1).trim()));
    } catch {}
  }
  return out;
}

/**
 * Cookie からセッションを探す。https では __Host- の Cookie を先に見て、なければ前の名前（kanzume_session）を legacy: true で引く。
 * 同じ名前に有効なセッションが 2 つ以上あれば、どちらが本物か分からないので使わない
 * （先頭のものを使うと、ほかのサブドメインから置かれた Cookie で別のユーザーとしてログインさせられる）
 */
export function findSession<T>(
  req: IncomingMessage,
  origin: string,
  lookup: (id: string, legacy: boolean) => T | null,
): { id: string; value: T; legacy: boolean } | null {
  const names: [string, boolean][] = origin.startsWith("https:")
    ? [
        [HOST_SESSION_COOKIE, false],
        [SESSION_COOKIE, true],
      ]
    : [[SESSION_COOKIE, false]];
  for (const [name, legacy] of names) {
    const found = new Map<string, T>();
    for (const id of readCookies(req, name)) {
      if (found.has(id)) continue;
      const value = lookup(id, legacy);
      if (value !== null) found.set(id, value);
    }
    if (found.size > 1) return null;
    for (const [id, value] of found) return { id, value, legacy };
  }
  return null;
}

export type ChallengePurpose = "register" | "login" | "site-register" | "site-login";

const PURPOSE_BYTE: Record<ChallengePurpose, number> = { register: 1, login: 2, "site-register": 3, "site-login": 4 };
const NONCE = 16;
const MAC = 16;

// 発行した challenge をサーバーに保存しないのは、認証なしで呼べるログイン用の発行を連打されると、
// 保存数の上限で正規ユーザーの進行中の challenge が追い出されてしまうため
export class Challenges {
  #secret = randomBytes(32);
  #used = new Map<string, number>();
  /** 検証中の challenge */
  #claimed = new Set<string>();

  #mac(body: Buffer): Buffer {
    return createHmac("sha256", this.#secret).update(body).digest().subarray(0, MAC);
  }

  create(purpose: ChallengePurpose, now = Date.now()): Uint8Array<ArrayBuffer> {
    const body = Buffer.alloc(NONCE + 8 + 1);
    randomBytes(NONCE).copy(body);
    body.writeBigUInt64BE(BigInt(now), NONCE);
    body[NONCE + 8] = PURPOSE_BYTE[purpose];
    return new Uint8Array(Buffer.concat([body, this.#mac(body)]));
  }

  check(challenge: string, purpose: ChallengePurpose, now = Date.now()): boolean {
    const raw = Buffer.from(challenge, "base64url");
    if (raw.length !== NONCE + 8 + 1 + MAC) return false;
    const body = raw.subarray(0, NONCE + 8 + 1);
    if (!timingSafeEqual(raw.subarray(NONCE + 8 + 1), this.#mac(body))) return false;
    if (body[NONCE + 8] !== PURPOSE_BYTE[purpose]) return false;
    const issued = Number(body.readBigUInt64BE(NONCE));
    if (now < issued || now - issued > CHALLENGE_TTL_MS) return false;
    return !this.#used.has(challenge);
  }

  /**
   * 検証を始めるときに、その challenge を押さえる（同時に送られた同じ応答の 2 つ目以降は通さない）。
   * 検証に失敗したら release、成功したら markUsed する
   */
  claim(challenge: string, purpose: ChallengePurpose, now = Date.now()): boolean {
    if (this.#claimed.has(challenge) || !this.check(challenge, purpose, now)) return false;
    this.#claimed.add(challenge);
    return true;
  }

  release(challenge: string): void {
    this.#claimed.delete(challenge);
  }

  // 検証に成功したものだけを記録するので、この Map が増えるのは本当に登録・ログインした回数ぶんだけ
  markUsed(challenge: string, now = Date.now()): void {
    this.#claimed.delete(challenge);
    for (const [c, at] of this.#used) {
      if (now - at <= CHALLENGE_TTL_MS) break;
      this.#used.delete(c);
    }
    this.#used.set(challenge, now);
  }
}
