import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export const SESSION_COOKIE = "kanzume_session";
// Cookie を無期限にしないのは、ブラウザが Max-Age を最長 400 日に切り詰めるため
export const SESSION_COOKIE_MAX_AGE = 400 * 24 * 60 * 60;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export function readCookie(req: IncomingMessage, name: string): string | null {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1 || part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      continue;
    }
  }
  return null;
}

export type ChallengePurpose = "register" | "login";

const PURPOSE_BYTE: Record<ChallengePurpose, number> = { register: 1, login: 2 };
const NONCE = 16;
const MAC = 16;

// 発行した challenge をサーバーに保存しないのは、認証なしで呼べるログイン用の発行を連打されると、
// 保存数の上限で正規ユーザーの進行中の challenge が追い出されてしまうため
export class Challenges {
  #secret = randomBytes(32);
  #used = new Map<string, number>();

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

  // 検証に成功したものだけを記録するので、この Map が増えるのは本当に登録・ログインした回数ぶんだけ
  markUsed(challenge: string, now = Date.now()): void {
    for (const [c, at] of this.#used) {
      if (now - at <= CHALLENGE_TTL_MS) break;
      this.#used.delete(c);
    }
    this.#used.set(challenge, now);
  }
}
