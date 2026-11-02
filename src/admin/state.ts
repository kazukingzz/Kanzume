import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { SESSION_COOKIE_MAX_AGE } from "./session.ts";

export interface StoredCredential {
  id: string;
  publicKey: string;
  counter: number;
  transports?: string[];
  createdAt: string;
  /** 管理画面に出す識別名。登録時に自動で付け、あとから変えられる */
  name?: string;
  /** パスキーを保存した認証器の種類 */
  aaguid?: string;
  /** 登録したブラウザ（「Mac・Chrome」など） */
  device?: string;
  lastUsedAt?: string;
}

export type RepoScope = "read" | "write";

/** リポジトリ単位のトークン。値はハッシュだけを保存し、発行したときに 1 回だけ見せる */
export interface RepoToken {
  id: string;
  repo: string;
  scope: RepoScope;
  hash: string;
  createdAt: string;
  expiresAt: string | null;
}

interface StateFile {
  userId: string;
  teamId: string;
  // ハッシュにしないのは、管理画面でいつでも再表示してコピーできるようにするため
  deployToken: string;
  credentials: StoredCredential[];
  repoTokens?: RepoToken[];
}

interface StoredFile extends StateFile {
  sessions?: Record<string, number>;
}

const hashSession = (id: string) => createHash("sha256").update(id).digest("hex");
const SESSION_IDLE_MS = SESSION_COOKIE_MAX_AGE * 1000;
const TOUCH_SAVE_INTERVAL_MS = 24 * 60 * 60 * 1000;

function newToken(): string {
  return `kz_${randomBytes(24).toString("base64url")}`;
}

const TEAM_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const TEAM_ID_LENGTH = 16;

function newTeamId(): string {
  return Array.from(randomBytes(TEAM_ID_LENGTH), (b) => TEAM_ALPHABET[b & 31]).join("");
}

export function normalizeTeamId(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}

export function formatTeamId(id: string): string {
  return id.match(/.{1,4}/g)!.join("-");
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export class AdminState {
  #file: string;
  #state: StateFile = { userId: "", teamId: "", deployToken: "", credentials: [] };
  #sessions = new Map<string, number>();
  #saving: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.#file = path.join(dataDir, "admin.json");
  }

  async init(): Promise<void> {
    let stored: StoredFile | null = null;
    try {
      stored = JSON.parse(await fs.readFile(this.#file, "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (!stored) {
      this.#state = { userId: randomBytes(16).toString("base64url"), teamId: newTeamId(), deployToken: newToken(), credentials: [] };
      await this.#save();
      return;
    }
    const dir = path.dirname(this.#file);
    const base = path.basename(this.#file);
    for (const name of await fs.readdir(dir)) {
      if (name.startsWith(`${base}.`) && name.endsWith(".tmp")) await fs.rm(path.join(dir, name), { force: true });
    }
    const { sessions, ...state } = stored;
    this.#state = state;
    if (sessions && typeof sessions === "object" && !Array.isArray(sessions)) this.#sessions = new Map(Object.entries(sessions));
    const pruned = this.#prune(Date.now());
    if (!this.#state.teamId || pruned) {
      this.#state.teamId ||= newTeamId();
      await this.#save();
    }
  }

  flush(): Promise<void> {
    return this.#saving;
  }

  // 直列にしないと、同時ログインなどで書き込みが重なったときに一時ファイルの rename が ENOENT で失敗する
  #save(): Promise<void> {
    const run = this.#saving.then(async () => {
      const data: StoredFile = { ...this.#state, sessions: Object.fromEntries(this.#sessions) };
      await fs.mkdir(path.dirname(this.#file), { recursive: true });
      const tmp = `${this.#file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
      await fs.rename(tmp, this.#file);
    });
    this.#saving = run.catch(() => {});
    return run;
  }

  #prune(now: number): boolean {
    let pruned = false;
    for (const [hash, lastSeen] of this.#sessions) {
      if (now - lastSeen > SESSION_IDLE_MS) {
        this.#sessions.delete(hash);
        pruned = true;
      }
    }
    return pruned;
  }

  get userId(): string {
    return this.#state.userId;
  }

  get teamId(): string {
    return formatTeamId(this.#state.teamId);
  }

  checkTeamId(input: string): boolean {
    return safeEqual(normalizeTeamId(input), this.#state.teamId);
  }

  get deployToken(): string {
    return this.#state.deployToken;
  }

  get credentials(): readonly StoredCredential[] {
    return this.#state.credentials;
  }

  checkDeployToken(token: string): boolean {
    return safeEqual(token, this.#state.deployToken);
  }

  async rotateDeployToken(): Promise<string> {
    this.#state.deployToken = newToken();
    await this.#save();
    return this.#state.deployToken;
  }

  repoTokens(repo: string): RepoToken[] {
    const now = Date.now();
    return (this.#state.repoTokens ?? []).filter((t) => t.repo === repo && (!t.expiresAt || Date.parse(t.expiresAt) > now));
  }

  async createRepoToken(repo: string, scope: RepoScope, ttlSeconds: number | null): Promise<{ token: string; info: RepoToken }> {
    const token = `kzr_${randomBytes(24).toString("base64url")}`;
    const info: RepoToken = {
      id: randomBytes(6).toString("hex"),
      repo,
      scope,
      hash: createHash("sha256").update(token).digest("hex"),
      createdAt: new Date().toISOString(),
      expiresAt: ttlSeconds ? new Date(Date.now() + ttlSeconds * 1000).toISOString() : null,
    };
    const now = Date.now();
    // 期限切れのトークンはこのときに掃除する
    this.#state.repoTokens = [...(this.#state.repoTokens ?? []).filter((t) => !t.expiresAt || Date.parse(t.expiresAt) > now), info];
    await this.#save();
    return { token, info };
  }

  async revokeRepoTokens(repo: string, id?: string): Promise<boolean> {
    const before = this.#state.repoTokens ?? [];
    const after = before.filter((t) => t.repo !== repo || (id !== undefined && t.id !== id));
    if (after.length === before.length) return false;
    this.#state.repoTokens = after;
    await this.#save();
    return true;
  }

  /** 全体の Token はすべてのリポジトリに書き込める。リポジトリのトークンはそのリポジトリだけ */
  repoAccess(repo: string, token: string): RepoScope | null {
    if (!token) return null;
    if (this.checkDeployToken(token)) return "write";
    const hash = createHash("sha256").update(token).digest("hex");
    const now = Date.now();
    const found = (this.#state.repoTokens ?? []).find((t) => t.repo === repo && safeEqual(t.hash, hash) && (!t.expiresAt || Date.parse(t.expiresAt) > now));
    return found?.scope ?? null;
  }

  async addCredential(credential: StoredCredential): Promise<void> {
    this.#state.credentials.push(credential);
    await this.#save();
  }

  get sessionCount(): number {
    return this.#sessions.size;
  }

  async createSession(): Promise<string> {
    const id = randomBytes(32).toString("base64url");
    const hash = hashSession(id);
    const now = Date.now();
    this.#prune(now);
    this.#sessions.set(hash, now);
    try {
      await this.#save();
    } catch (err) {
      this.#sessions.delete(hash);
      throw err;
    }
    return id;
  }

  hasSession(id: string | null): boolean {
    if (!id) return false;
    const hash = hashSession(id);
    const lastSeen = this.#sessions.get(hash);
    const now = Date.now();
    if (lastSeen === undefined) return false;
    if (now - lastSeen > SESSION_IDLE_MS) {
      this.#sessions.delete(hash);
      return false;
    }
    // 毎回保存しないのは、リクエストのたびに admin.json 全体を書き直すことになるため
    if (now - lastSeen > TOUCH_SAVE_INTERVAL_MS) {
      this.#sessions.set(hash, now);
      this.#save().catch((err) => console.error("[kanzume] セッションの保存に失敗:", err));
    }
    return true;
  }

  async removeSession(id: string | null): Promise<void> {
    if (!id) return;
    const hash = hashSession(id);
    const lastSeen = this.#sessions.get(hash);
    if (lastSeen === undefined) return;
    this.#sessions.delete(hash);
    try {
      await this.#save();
    } catch (err) {
      this.#sessions.set(hash, lastSeen);
      throw err;
    }
  }

  async updateCounter(id: string, counter: number): Promise<void> {
    const credential = this.#state.credentials.find((c) => c.id === id);
    if (!credential) return;
    credential.counter = counter;
    credential.lastUsedAt = new Date().toISOString();
    await this.#save();
  }

  async renameCredential(id: string, name: string): Promise<boolean> {
    const credential = this.#state.credentials.find((c) => c.id === id);
    if (!credential) return false;
    const before = credential.name;
    credential.name = name;
    try {
      await this.#save();
    } catch (err) {
      credential.name = before;
      throw err;
    }
    return true;
  }
}
