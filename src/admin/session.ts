import type { IncomingMessage } from "node:http";

export const SESSION_COOKIE = "kanzume_session";
// Cookie を無期限にしないのは、ブラウザが Max-Age を最長 400 日に切り詰めるため。開くたびに延長する
export const SESSION_COOKIE_MAX_AGE = 400 * 24 * 60 * 60;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export function readCookie(req: IncomingMessage, name: string): string | null {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

export class Challenges {
  #challenges = new Map<string, number>();

  add(challenge: string): void {
    const now = Date.now();
    for (const [c, expires] of this.#challenges) if (expires < now) this.#challenges.delete(c);
    this.#challenges.set(challenge, now + CHALLENGE_TTL_MS);
  }

  consume(challenge: string): boolean {
    const expires = this.#challenges.get(challenge);
    this.#challenges.delete(challenge);
    return !!expires && expires >= Date.now();
  }
}
