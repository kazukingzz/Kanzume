import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";

export const SESSION_COOKIE = "kanzume_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export function readCookie(req: IncomingMessage, name: string): string | null {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

export class Sessions {
  #sessions = new Map<string, number>();
  #challenges = new Map<string, number>();

  create(): string {
    const id = randomBytes(32).toString("base64url");
    this.#sessions.set(id, Date.now() + SESSION_TTL_MS);
    return id;
  }

  valid(id: string | null): boolean {
    if (!id) return false;
    const expires = this.#sessions.get(id);
    if (!expires) return false;
    if (expires < Date.now()) {
      this.#sessions.delete(id);
      return false;
    }
    return true;
  }

  destroy(id: string | null): void {
    if (id) this.#sessions.delete(id);
  }

  addChallenge(challenge: string): void {
    const now = Date.now();
    for (const [c, expires] of this.#challenges) if (expires < now) this.#challenges.delete(c);
    this.#challenges.set(challenge, now + CHALLENGE_TTL_MS);
  }

  consumeChallenge(challenge: string): boolean {
    const expires = this.#challenges.get(challenge);
    this.#challenges.delete(challenge);
    return !!expires && expires >= Date.now();
  }
}
