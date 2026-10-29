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

export class Challenges {
  #challenges = new Map<string, { purpose: ChallengePurpose; expires: number }>();

  add(challenge: string, purpose: ChallengePurpose): void {
    const now = Date.now();
    for (const [c, { expires }] of this.#challenges) if (expires < now) this.#challenges.delete(c);
    this.#challenges.set(challenge, { purpose, expires: now + CHALLENGE_TTL_MS });
  }

  // 用途を見ないと、認証なしで出せるログイン用の challenge で新しいパスキーを登録できてしまう
  consume(challenge: string, purpose: ChallengePurpose): boolean {
    const entry = this.#challenges.get(challenge);
    this.#challenges.delete(challenge);
    return !!entry && entry.purpose === purpose && entry.expires >= Date.now();
  }
}
