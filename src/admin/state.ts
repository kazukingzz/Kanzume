import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export interface StoredCredential {
  id: string;
  publicKey: string;
  counter: number;
  transports?: string[];
  createdAt: string;
}

interface StateFile {
  userId: string;
  teamId: string;
  // ハッシュにしないのは、管理画面でいつでも再表示してコピーできるようにするため
  deployToken: string;
  credentials: StoredCredential[];
  sessions?: string[];
}

const hashSession = (id: string) => createHash("sha256").update(id).digest("hex");

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

  constructor(dataDir: string) {
    this.#file = path.join(dataDir, "admin.json");
  }

  async init(): Promise<void> {
    try {
      this.#state = JSON.parse(await fs.readFile(this.#file, "utf8"));
      if (!this.#state.teamId) {
        this.#state.teamId = newTeamId();
        await this.#save();
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      this.#state = { userId: randomBytes(16).toString("base64url"), teamId: newTeamId(), deployToken: newToken(), credentials: [] };
      await this.#save();
    }
  }

  async #save(): Promise<void> {
    await fs.mkdir(path.dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.#state, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.#file);
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

  async addCredential(credential: StoredCredential): Promise<void> {
    this.#state.credentials.push(credential);
    await this.#save();
  }

  async createSession(): Promise<string> {
    const id = randomBytes(32).toString("base64url");
    (this.#state.sessions ??= []).push(hashSession(id));
    await this.#save();
    return id;
  }

  hasSession(id: string | null): boolean {
    return !!id && (this.#state.sessions ?? []).includes(hashSession(id));
  }

  async removeSession(id: string | null): Promise<void> {
    if (!id || !this.hasSession(id)) return;
    this.#state.sessions = this.#state.sessions!.filter((s) => s !== hashSession(id));
    await this.#save();
  }

  async updateCounter(id: string, counter: number): Promise<void> {
    const credential = this.#state.credentials.find((c) => c.id === id);
    if (!credential) return;
    credential.counter = counter;
    await this.#save();
  }
}
