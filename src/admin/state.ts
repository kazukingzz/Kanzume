import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { SESSION_COOKIE_MAX_AGE } from "./session.ts";
import { UserFacingError } from "../errors.ts";
import { ADMIN_FILE } from "../layout.ts";
import type { ManagedFiles } from "../managed-files.ts";

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
  /** ID を渡さなくても使えるパスキーか（登録したときの credProps）。ブラウザが答えなければ未設定 */
  discoverable?: boolean;
  /** パスキーの持ち主。古い admin.json では未設定（読み込むときに最初の管理者にする） */
  userId?: string;
}

export type Role = "admin" | "member";

/** 管理画面のユーザー。管理者はすべてのサイト、メンバーは sites のサイトだけを扱える */
export interface User {
  id: string;
  name: string;
  role: Role;
  sites: string[];
  createdAt: string;
}

/** サイトへの招待。1 回だけ使える。値はハッシュだけを保存し、作ったときに 1 回だけ見せる */
export interface Invite {
  id: string;
  site: string;
  hash: string;
  createdAt: string;
  expiresAt: string;
  createdBy: string;
  usedAt?: string;
  usedBy?: string;
  revokedAt?: string;
}

export class UserError extends UserFacingError {}

const NO_MANAGED_FILES: ManagedFiles = Object.freeze({});

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_NAME = 40;

/** ユーザー・パスキー・トークンの名前をそろえる（制御文字を外し、40 文字まで） */
export function normalizeName(input: unknown): string {
  return String(input ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, MAX_NAME);
}

/**
 * ユーザーの個人トークン。そのユーザーが扱えるサイト（管理者ならすべて）に、git push と GitHub Actions からデプロイできる。
 * 値はハッシュだけを保存し、発行したときに 1 回だけ見せる
 */
export interface UserToken {
  id: string;
  userId: string;
  name: string;
  hash: string;
  createdAt: string;
  expiresAt: string | null;
}

interface StateFile {
  userId: string;
  credentials: StoredCredential[];
  userTokens?: UserToken[];
  /** ルートドメイン（例: example.com）。サイトは <name>.<domain> で配信する。未設定なら管理画面を開いたホストを使う */
  domain?: string;
  users?: User[];
  invites?: Invite[];
  /**
   * 管理画面にログイン・登録したホスト名（パスキーはこのホストに紐づく）。
   * サイトのサブドメインがこれと重なると管理画面に入れなくなるので、サイトの名前に使わせない
   */
  adminHosts?: string[];
  /** Kanzume が代わりに返すファイル（robots.txt・security.txt）の、全体の既定 */
  managedFiles?: ManagedFiles;
  /** Worker の子プロセスを作り直す間隔（分）。未設定なら作り直さない */
  workerRecycleMinutes?: number;
}

interface Session {
  lastSeen: number;
  userId: string;
  /**
   * __Host- の Cookie を入れたあとに作ったセッション。https では前の名前の Cookie（kanzume_session）では受け付けない
   * （前の名前はほかのサブドメインからも置けるので、新しいセッションを置かれて別のユーザーとしてログインさせられないように）
   */
  hostCookie?: true;
}

interface StoredFile extends StateFile {
  /** 古い形式は最終利用時刻（数値）だけ */
  sessions?: Record<string, number | Session>;
}

const hashSession = (id: string) => createHash("sha256").update(id).digest("hex");
const SESSION_IDLE_MS = SESSION_COOKIE_MAX_AGE * 1000;
const TOUCH_SAVE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export class DomainError extends UserFacingError {}

export const MAX_WORKER_RECYCLE_MINUTES = 7 * 24 * 60;

const HOST_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const DOMAIN = new RegExp(`^${HOST_LABEL}(?:\\.${HOST_LABEL})*(?::\\d{1,5})?$`);

/** 入力されたドメインを example.com の形にそろえる。空なら null（自動）。https:// や末尾の / は外す */
export function normalizeDomain(input: string): string | null {
  const v = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  if (!v) return null;
  if (v.length > 253 || !DOMAIN.test(v)) throw new DomainError("ドメインの形式が正しくありません（例: example.com）");
  // URL として使えるか（ポートの範囲、数字だけの最後のラベルなど）。サイトの URL を作るときに new URL が失敗しないようにする
  let host: string | null = null;
  try {
    host = new URL(`https://${v}`).host;
  } catch {}
  const bare = v.replace(/:443$/, "");
  if (host !== bare || /\.\d+(:\d+)?$/.test(v)) throw new DomainError("ドメインの形式が正しくありません（例: example.com）");
  return v;
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export class AdminState {
  #file: string;
  #state: StateFile = { userId: "", credentials: [] };
  #sessions = new Map<string, Session>();
  #saving: Promise<void> = Promise.resolve();
  /** 保存したあとに呼ぶ（バックアップのきっかけ） */
  onChange: (() => void) | null = null;

  constructor(dataDir: string) {
    this.#file = path.join(dataDir, ADMIN_FILE);
  }

  async init(): Promise<void> {
    let stored: StoredFile | null = null;
    try {
      stored = JSON.parse(await fs.readFile(this.#file, "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (!stored) {
      const userId = randomBytes(16).toString("base64url");
      this.#state = { userId, credentials: [], users: [this.#newAdmin(userId)], invites: [] };
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
    // ユーザーがない（ロールを入れる前の）admin.json は、今のパスキーとセッションをすべて最初の管理者のものにする
    let migrated = false;
    const withoutUsers = !this.#state.users?.length;
    if (withoutUsers) {
      this.#state.userId ||= randomBytes(16).toString("base64url");
      this.#state.users = [this.#newAdmin(this.#state.userId)];
      migrated = true;
    }
    this.#state.invites ??= [];
    this.#state.userTokens ??= [];
    // サイト・リポジトリごとのトークンと、全体の Token（とチーム ID）はやめた（個人トークンに置き換え）
    for (const key of ["repoTokens", "deployToken", "teamId"]) {
      if (key in this.#state) {
        delete (this.#state as unknown as Record<string, unknown>)[key];
        migrated = true;
      }
    }
    const firstAdmin = this.users.find((u) => u.role === "admin")!.id;
    // 持ち主のいないパスキーは最初の管理者に付け替えずに捨てる（消されたユーザーのパスキーが管理者のものになってしまう）。
    // 持ち主が未設定なのは、ユーザーを入れる前の admin.json（パスキーはすべて最初の管理者のもの）だけ
    this.#state.credentials = this.#state.credentials.filter((c) => {
      if (!c.userId && withoutUsers) {
        c.userId = firstAdmin;
        migrated = true;
        return true;
      }
      if (c.userId && this.user(c.userId)) return true;
      console.warn(`[kanzume] 持ち主のいないパスキー（${c.id}）を削除しました`);
      migrated = true;
      return false;
    });
    if (sessions && typeof sessions === "object" && !Array.isArray(sessions)) {
      for (const [hash, v] of Object.entries(sessions)) {
        const session = typeof v === "number" ? { lastSeen: v, userId: firstAdmin } : v;
        if (session && typeof session.lastSeen === "number" && this.user(session.userId)) this.#sessions.set(hash, session);
      }
    }
    const pruned = this.#prune(Date.now());
    if (pruned || migrated) await this.#save();
  }

  flush(): Promise<void> {
    return this.#saving;
  }

  // 直列にしないと、同時ログインなどで書き込みが重なったときに一時ファイルの rename が ENOENT で失敗する
  /**
   * backup: false はログインやセッションの更新など、バックアップをすぐ取るほどではない変更（定期バックアップで拾う）。
   * ログインのたびに世代が増えて、古い世代が押し出されないようにする
   */
  #save({ backup = true }: { backup?: boolean } = {}): Promise<void> {
    const run = this.#saving.then(async () => {
      const data: StoredFile = { ...this.#state, sessions: Object.fromEntries(this.#sessions) };
      await fs.mkdir(path.dirname(this.#file), { recursive: true });
      const tmp = `${this.#file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
      await fs.rename(tmp, this.#file);
      if (backup) this.onChange?.();
    });
    this.#saving = run.catch(() => {});
    return run;
  }

  #prune(now: number): boolean {
    let pruned = false;
    for (const [hash, { lastSeen }] of this.#sessions) {
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

  get domain(): string | null {
    return this.#state.domain ?? null;
  }

  async setDomain(input: string): Promise<string | null> {
    const domain = normalizeDomain(input);
    const before = this.#state.domain;
    if (domain) this.#state.domain = domain;
    else delete this.#state.domain;
    try {
      await this.#save();
    } catch (err) {
      this.#state.domain = before;
      throw err;
    }
    return domain;
  }

  get workerRecycleMinutes(): number {
    return this.#state.workerRecycleMinutes ?? 0;
  }

  /** 0 なら作り直さない */
  async setWorkerRecycleMinutes(input: unknown): Promise<number> {
    const minutes = typeof input === "number" ? input : Number.NaN;
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > MAX_WORKER_RECYCLE_MINUTES) {
      throw new UserError(`0〜${MAX_WORKER_RECYCLE_MINUTES} の整数（分）で指定してください`);
    }
    const before = this.#state.workerRecycleMinutes;
    if (minutes) this.#state.workerRecycleMinutes = minutes;
    else delete this.#state.workerRecycleMinutes;
    try {
      await this.#save();
    } catch (err) {
      this.#state.workerRecycleMinutes = before;
      throw err;
    }
    return minutes;
  }

  /** Kanzume が代わりに返すファイルの、全体の既定（サイトごとの上書きは Sites の設定にある） */
  get managedFiles(): ManagedFiles {
    return this.#state.managedFiles ?? NO_MANAGED_FILES;
  }

  /** 確かめ済みの設定に置き換える */
  async setManagedFiles(next: ManagedFiles): Promise<ManagedFiles> {
    const before = this.#state.managedFiles;
    this.#state.managedFiles = next;
    try {
      await this.#save();
    } catch (err) {
      this.#state.managedFiles = before;
      throw err;
    }
    return next;
  }

  get credentials(): readonly StoredCredential[] {
    return this.#state.credentials;
  }

  get adminHosts(): readonly string[] {
    return this.#state.adminHosts ?? [];
  }

  /** 管理画面にログイン・登録したホストを覚える（サイトの名前に使わせないため） */
  async addAdminHost(host: string): Promise<void> {
    const name = host.toLowerCase().replace(/:\d+$/, "");
    if (this.adminHosts.includes(name)) return;
    this.#state.adminHosts = [...this.adminHosts, name];
    await this.#save({ backup: false });
  }

  // ---------- 個人トークン ----------

  userTokens(userId: string): UserToken[] {
    const now = Date.now();
    return (this.#state.userTokens ?? []).filter((t) => t.userId === userId && (!t.expiresAt || Date.parse(t.expiresAt) > now));
  }

  async createUserToken(userId: string, name: string, ttlSeconds: number | null): Promise<{ token: string; info: UserToken }> {
    if (!this.user(userId)) throw new UserError("ユーザーが見つかりません");
    const token = `kzu_${randomBytes(24).toString("base64url")}`;
    const now = Date.now();
    const info: UserToken = {
      id: randomBytes(6).toString("hex"),
      userId,
      name: normalizeName(name) || "トークン",
      hash: createHash("sha256").update(token).digest("hex"),
      createdAt: new Date(now).toISOString(),
      expiresAt: ttlSeconds ? new Date(now + ttlSeconds * 1000).toISOString() : null,
    };
    // 期限切れのトークンはこのときに掃除する
    this.#state.userTokens = [...(this.#state.userTokens ?? []).filter((t) => !t.expiresAt || Date.parse(t.expiresAt) > now), info];
    await this.#save();
    return { token, info };
  }

  async revokeUserToken(userId: string, id: string): Promise<boolean> {
    const before = this.#state.userTokens ?? [];
    const after = before.filter((t) => !(t.userId === userId && t.id === id));
    if (after.length === before.length) return false;
    this.#state.userTokens = after;
    await this.#save();
    return true;
  }

  /** 個人トークンの持ち主（期限切れ・消されたユーザーなら null） */
  tokenUser(token: string): User | null {
    if (!token) return null;
    const hash = createHash("sha256").update(token).digest("hex");
    const now = Date.now();
    const found = (this.#state.userTokens ?? []).find((t) => safeEqual(t.hash, hash) && (!t.expiresAt || Date.parse(t.expiresAt) > now));
    return this.user(found?.userId) ?? null;
  }

  /**
   * /_api/deploy（GitHub Actions）に使えるトークンか。sites が null ならすべてのサイト（管理者の個人トークン）、
   * 配列ならそのサイトだけ（メンバーの個人トークン）
   */
  deployAccess(token: string): { sites: string[] | null } | null {
    if (!token) return null;
    const user = this.tokenUser(token);
    if (!user) return null;
    return user.role === "admin" ? { sites: null } : { sites: [...user.sites] };
  }

  /** git の push / clone。そのリポジトリ（＝同じ名前のサイト）を扱えるユーザーの個人トークン */
  repoAccess(repo: string, token: string): boolean {
    const access = this.deployAccess(token);
    return !!access && (access.sites === null || access.sites.includes(repo));
  }

  /**
   * パスキーを足す。ID はすべてのユーザーで重ならないようにする（ログインは ID だけで引くので、ほかの人のパスキーと同じ ID を
   * 登録できると、削除・名前の変更・ログインで取り違える）。持ち主がもういなければ足さない
   */
  async addCredential(credential: StoredCredential): Promise<void> {
    const userId = credential.userId ?? this.#primaryAdmin();
    if (!this.user(userId)) throw new UserError("ユーザーが見つかりません");
    if (this.#state.credentials.some((c) => c.id === credential.id)) throw new UserError("このパスキーはすでに登録されています");
    this.#state.credentials.push({ ...credential, userId });
    await this.#save();
  }

  get sessionCount(): number {
    return this.#sessions.size;
  }

  /** userId を省くと最初の管理者（テストと初回セットアップ用） */
  async createSession(userId: string = this.#primaryAdmin()): Promise<string> {
    if (!this.user(userId)) throw new UserError("ユーザーが見つかりません");
    const id = randomBytes(32).toString("base64url");
    const hash = hashSession(id);
    const now = Date.now();
    this.#prune(now);
    this.#sessions.set(hash, { lastSeen: now, userId, hostCookie: true });
    try {
      await this.#save({ backup: false });
    } catch (err) {
      this.#sessions.delete(hash);
      throw err;
    }
    return id;
  }

  hasSession(id: string | null): boolean {
    return this.sessionUser(id) !== null;
  }

  /**
   * セッションのユーザー。期限切れや、消されたユーザーのセッションなら null。
   * legacy は https で前の名前の Cookie から読んだとき（__Host- を入れる前からあるセッションだけ受け付ける）
   */
  sessionUser(id: string | null, { legacy = false }: { legacy?: boolean } = {}): User | null {
    if (!id) return null;
    const hash = hashSession(id);
    const session = this.#sessions.get(hash);
    const now = Date.now();
    if (!session || (legacy && session.hostCookie)) return null;
    const user = this.user(session.userId);
    if (!user || now - session.lastSeen > SESSION_IDLE_MS) {
      this.#sessions.delete(hash);
      return null;
    }
    // 毎回保存しないのは、リクエストのたびに admin.json 全体を書き直すことになるため
    if (now - session.lastSeen > TOUCH_SAVE_INTERVAL_MS) {
      session.lastSeen = now;
      this.#save({ backup: false }).catch((err) => console.error("[kanzume] セッションの保存に失敗:", err));
    }
    return user;
  }

  async removeSession(id: string | null): Promise<void> {
    if (!id) return;
    const hash = hashSession(id);
    const session = this.#sessions.get(hash);
    if (session === undefined) return;
    this.#sessions.delete(hash);
    try {
      await this.#save({ backup: false });
    } catch (err) {
      this.#sessions.set(hash, session);
      throw err;
    }
  }

  // ---------- ユーザー ----------

  #newAdmin(id: string): User {
    return { id, name: "管理者", role: "admin", sites: [], createdAt: new Date().toISOString() };
  }

  #primaryAdmin(): string {
    return this.users.find((u) => u.role === "admin")?.id ?? this.#state.userId;
  }

  get users(): readonly User[] {
    return this.#state.users ?? [];
  }

  user(id: string | undefined): User | undefined {
    return id ? this.#state.users?.find((u) => u.id === id) : undefined;
  }

  credentialsOf(userId: string): StoredCredential[] {
    return this.#state.credentials.filter((c) => c.userId === userId);
  }

  /** 初回セットアップのパスキーを持たせる管理者（まだパスキーのない最初の管理者） */
  get setupUserId(): string {
    return this.#primaryAdmin();
  }

  async createUser(name: string, role: Role, sites: string[] = []): Promise<User> {
    const user: User = {
      id: randomBytes(16).toString("base64url"),
      name: normalizeName(name) || (role === "admin" ? "管理者" : "メンバー"),
      role,
      sites: [...new Set(sites)],
      createdAt: new Date().toISOString(),
    };
    this.#state.users = [...this.users, user];
    await this.#save();
    return user;
  }

  #admins(): User[] {
    return this.users.filter((u) => u.role === "admin");
  }

  async updateUser(id: string, patch: { name?: string; role?: Role; addSite?: string; removeSite?: string }): Promise<User> {
    const user = this.user(id);
    if (!user) throw new UserError("ユーザーが見つかりません");
    if (patch.role && patch.role !== user.role && user.role === "admin" && this.#admins().length <= 1)
      throw new UserError("最後の管理者はメンバーにできません");
    if (patch.name !== undefined) {
      const name = normalizeName(patch.name);
      if (!name) throw new UserError("名前を入力してください");
      user.name = name;
    }
    if (patch.role) user.role = patch.role;
    if (patch.addSite && !user.sites.includes(patch.addSite)) user.sites.push(patch.addSite);
    if (patch.removeSite) user.sites = user.sites.filter((s) => s !== patch.removeSite);
    await this.#save();
    return user;
  }

  /** ユーザーを消す。パスキーとセッションも消す */
  async removeUser(id: string): Promise<void> {
    const user = this.user(id);
    if (!user) throw new UserError("ユーザーが見つかりません");
    if (user.role === "admin" && this.#admins().length <= 1) throw new UserError("最後の管理者は削除できません");
    this.#state.users = this.users.filter((u) => u.id !== id);
    this.#state.credentials = this.#state.credentials.filter((c) => c.userId !== id);
    this.#state.userTokens = (this.#state.userTokens ?? []).filter((t) => t.userId !== id);
    for (const [hash, s] of this.#sessions) if (s.userId === id) this.#sessions.delete(hash);
    await this.#save();
  }

  async removeCredential(id: string, userId: string): Promise<void> {
    const mine = this.credentialsOf(userId);
    if (!mine.some((c) => c.id === id)) throw new UserError("パスキーが見つかりません");
    if (mine.length <= 1) throw new UserError("最後のパスキーは削除できません");
    // ID が重なったパスキー（重なりを止める前に登録されたもの）があっても、ほかの人のものは消さない
    this.#state.credentials = this.#state.credentials.filter((c) => !(c.id === id && c.userId === userId));
    await this.#save();
  }

  // ---------- 招待 ----------

  /** サイトを消したときに、メンバーの参加先と招待から外す */
  async removeSiteAccess(site: string): Promise<void> {
    for (const u of this.users) u.sites = u.sites.filter((s) => s !== site);
    this.#state.invites = (this.#state.invites ?? []).filter((i) => i.site !== site);
    await this.#save();
  }

  /**
   * メンバー（と、まだ使われていない招待）がいるサイトか。ルートドメインのサイトは管理画面と同じオリジンで動くので、
   * メンバーのいるサイトはルートにしない（ルートのサイトにもメンバーを入れない）
   */
  siteHasMembers(site: string): boolean {
    return this.users.some((u) => u.role === "member" && u.sites.includes(site)) || this.invites(site).length > 0;
  }

  invites(site: string): Invite[] {
    const now = Date.now();
    return (this.#state.invites ?? []).filter((i) => i.site === site && !i.usedAt && !i.revokedAt && Date.parse(i.expiresAt) > now);
  }

  async createInvite(site: string, createdBy: string): Promise<{ token: string; invite: Invite }> {
    const token = `kzi_${randomBytes(24).toString("base64url")}`;
    const now = Date.now();
    const invite: Invite = {
      id: randomBytes(6).toString("hex"),
      site,
      hash: createHash("sha256").update(token).digest("hex"),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + INVITE_TTL_MS).toISOString(),
      createdBy,
    };
    // 使い終わった・期限切れの招待は、30 日たったらこのときに掃除する
    const keepUntil = now - 30 * 24 * 60 * 60 * 1000;
    this.#state.invites = [...(this.#state.invites ?? []).filter((i) => Date.parse(i.expiresAt) > keepUntil), invite];
    await this.#save();
    return { token, invite };
  }

  /** 使える招待（未使用・期限内・取り消されていない）だけを返す */
  checkInvite(token: string): Invite | null {
    if (!token) return null;
    const hash = createHash("sha256").update(token).digest("hex");
    const found = (this.#state.invites ?? []).find((i) => safeEqual(i.hash, hash));
    if (!found || found.usedAt || found.revokedAt || Date.parse(found.expiresAt) <= Date.now()) return null;
    return found;
  }

  /** 招待を使い、ユーザーをそのサイトのメンバーにする。使えなければ null */
  async consumeInvite(token: string, userId: string): Promise<Invite | null> {
    const invite = this.checkInvite(token);
    const user = this.user(userId);
    if (!invite || !user) return null;
    invite.usedAt = new Date().toISOString();
    invite.usedBy = userId;
    if (user.role !== "admin" && !user.sites.includes(invite.site)) user.sites.push(invite.site);
    await this.#save();
    return invite;
  }

  /**
   * 招待から新しいメンバーを作る。招待は同期的に使用済みにしてから保存するので、同じリンクで同時に 2 人登録されない。
   * 使えない招待なら null
   */
  async redeemInviteAsNewUser(token: string, name: string): Promise<User | null> {
    const invite = this.checkInvite(token);
    if (!invite) return null;
    const user: User = {
      id: randomBytes(16).toString("base64url"),
      name: normalizeName(name) || "メンバー",
      role: "member",
      sites: [invite.site],
      createdAt: new Date().toISOString(),
    };
    invite.usedAt = new Date().toISOString();
    invite.usedBy = user.id;
    this.#state.users = [...this.users, user];
    try {
      await this.#save();
    } catch (err) {
      delete invite.usedAt;
      delete invite.usedBy;
      this.#state.users = this.users.filter((u) => u.id !== user.id);
      throw err;
    }
    return user;
  }

  async revokeInvite(site: string, id: string): Promise<boolean> {
    const invite = (this.#state.invites ?? []).find((i) => i.site === site && i.id === id && !i.usedAt && !i.revokedAt);
    if (!invite) return false;
    invite.revokedAt = new Date().toISOString();
    await this.#save();
    return true;
  }

  async updateCounter(id: string, userId: string, counter: number): Promise<void> {
    const credential = this.#state.credentials.find((c) => c.id === id && c.userId === userId);
    if (!credential) return;
    credential.counter = counter;
    credential.lastUsedAt = new Date().toISOString();
    await this.#save({ backup: false });
  }

  async renameCredential(id: string, userId: string, name: string): Promise<boolean> {
    const credential = this.#state.credentials.find((c) => c.id === id && c.userId === userId);
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
