/**
 * 管理画面の API の土台: ルート表の形、リクエストごとの情報（Ctx）、応答の返し方。
 * 権限はルートごとに auth で宣言し、handler.ts がまとめて確かめる（ルートの中で isAdmin を見ない）
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Backup } from "../backup/backup.ts";
import type { Config } from "../config.ts";
import type { Deployer } from "../deploy/deployer.ts";
import type { GitHubOptions } from "../deploy/github.ts";
import type { DeployHistory } from "../deploy/history.ts";
import { UserFacingError } from "../errors.ts";
import type { Repos } from "../git/repos.ts";
import { readBody } from "../http.ts";
import type { Observability } from "../observability/events.ts";
import type { ResourceMonitor } from "../observability/resources.ts";
import type { Runtime } from "../runtime/runtime.ts";
import type { Sites } from "../sites.ts";
import type { Release, Store } from "../store.ts";
import type { Challenges } from "./session.ts";
import type { AdminState, User } from "./state.ts";

export const ADMIN_PATH = "/_admin/kanzume";

export interface AdminDeps {
  config: Config;
  state: AdminState;
  sites: Sites;
  repos: Repos;
  runtime: Runtime;
  history: DeployHistory;
  observability: Observability;
  resources: ResourceMonitor;
  deployer: Deployer;
  backup?: Backup | null;
  github?: Partial<GitHubOptions>;
  challenges: Challenges;
}

/**
 * - public: ログインしていなくても呼べる
 * - user: ログインしているユーザー
 * - admin: 管理者だけ
 * - site: そのサイト（パスの :site）を扱えるユーザー（管理者はすべて、メンバーは参加しているサイト）
 * - siteAdmin: 管理者だけが扱う、サイトの設定（メンバーと招待）
 */
export type Auth = "public" | "user" | "admin" | "site" | "siteAdmin";

export interface SiteRef {
  name: string;
  store: Store;
  /** まだデプロイしていないサイトでは undefined */
  release: Release | undefined;
}

export interface Ctx {
  deps: AdminDeps;
  req: IncomingMessage;
  res: ServerResponse;
  /** 管理画面を開いているホストのオリジン（Origin の照合とパスキーに使う） */
  origin: string;
  rpID: string;
  /** サイトの URL を作る基準（ルートドメインのオリジン） */
  siteRoot: string;
  query: URLSearchParams;
  params: Record<string, string>;
  sessionId: string | null;
  /** auth が public のルートでは null のことがある */
  user: User | null;
  isAdmin: boolean;
  /** 管理者はすべてのサイト、メンバーは参加しているサイトだけ */
  canSite(name: string): boolean;
  /** auth が site / siteAdmin のルートで、パスの :site のサイト */
  site: SiteRef;
  /** JSON の本文。読めない・大きすぎるときは 400 */
  body(limit?: number): Promise<Record<string, unknown>>;
}

/** auth が public 以外のルートで使う（ユーザーがいることは handler.ts が確かめている） */
export const userOf = (ctx: Ctx): User => ctx.user as User;

/** 200 以外や、ヘッダーを付けて返すとき。ルートは JSON にできる値を返せば 200 になる */
export class Reply {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Record<string, string>;

  constructor(status: number, body: unknown, headers: Record<string, string> = {}) {
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

export const reply = (status: number, body: unknown, headers?: Record<string, string>) => new Reply(status, body, headers);

/** 利用者に見せるエラー（handler.ts が { error } の JSON にする） */
export const fail = (status: number, message: string): never => {
  throw new UserFacingError(message, status);
};

export const forbidden = () => fail(403, "この操作の権限がありません");
export const notFound = (what = "Not Found") => fail(404, what);

/** ルートは、JSON にする値・Reply・何も返さない（自分で res に書いた）のどれか */
export type Handler = (ctx: Ctx) => unknown | Promise<unknown>;

export interface Route {
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** /api/sites/:site/kv/:ns のように書く。:name は / を含まない 1 区切り */
  path: string;
  auth: Auth;
  handle: Handler;
}

export interface CompiledRoute extends Route {
  pattern: RegExp;
  names: string[];
}

export function compile(routes: Route[]): CompiledRoute[] {
  return routes.map((r) => {
    const names: string[] = [];
    const source = r.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:(\w+)/g, (_, name: string) => {
      names.push(name);
      return "([^/]+)";
    });
    return { ...r, pattern: new RegExp(`^${source}$`), names };
  });
}

/** パスに合うルートと、:name の値（decodeURIComponent 済み）。パスは合うがメソッドが違うときは methodMismatch */
export function match(
  routes: CompiledRoute[],
  method: string,
  path: string,
): { route: CompiledRoute; params: Record<string, string> } | "methodMismatch" | null {
  let pathMatched = false;
  for (const route of routes) {
    const m = route.pattern.exec(path);
    if (!m) continue;
    pathMatched = true;
    if (route.method !== method) continue;
    const params: Record<string, string> = {};
    route.names.forEach((name, i) => {
      params[name] = decodeURIComponent(m[i + 1]);
    });
    return { route, params };
  }
  return pathMatched ? "methodMismatch" : null;
}

/** 本文を JSON のオブジェクトとして読む。空なら {}、読めない・大きすぎるときは 400 / 413 */
export async function readBodyJson(req: IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown>> {
  const raw = await readBody(req, limit);
  if (!raw) return fail(413, "リクエストの本文が大きすぎます");
  if (raw.length === 0) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw.toString("utf8"));
  } catch {
    value = null;
  }
  return isRecord(value) ? value : fail(400, "リクエストの本文を読めません（JSON のオブジェクトで送ってください）");
}

export const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** 文字列なら trim して返す。それ以外は "" */
export const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
