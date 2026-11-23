import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { format } from "node:util";
import { MAX_ERROR_MESSAGE, MAX_ERROR_NAME, MAX_ERROR_STACK } from "../runtime/protocol.ts";

export type Outcome = "ok" | "exception" | "exceededCpu" | "canceled";
export type LogLevel = "log" | "info" | "warn" | "error" | "debug";

const MAX_LOGS = 100;
const MAX_MESSAGE = 4096;
const MAX_SUBREQUESTS = 50;
const MAX_PATH = 1024;
const MAX_EXCEPTIONS = 20;

export interface ExceptionInfo {
  name: string;
  message: string;
  stack: string | null;
}

export interface Detail {
  url: string;
  request: Record<string, string>;
  response: Record<string, string>;
  logs: { ts: number; level: LogLevel; message: string }[];
  droppedLogs: number;
  exceptions: ExceptionInfo[];
  subrequests: { ts: number; method: string; url: string; status: number | null; durationMs: number; error: string | null }[];
}

const REQUEST_HEADERS = ["user-agent", "referer", "content-type", "content-length", "accept", "cf-connecting-ip"];
const RESPONSE_HEADERS = ["content-type", "content-length", "location", "cache-control"];

const INTERNAL_FRAME = /\((?:file:|node:)|\bat (?:file:|node:)|evalmachine\.<anonymous>/;

function workerStack(stack: string): string {
  return stack
    .split("\n")
    .filter((line) => !/^\s+at /.test(line) || !INTERNAL_FRAME.test(line))
    .join("\n");
}

/** Worker の例外を記録する形にする。大きさに上限を設ける（子から本体への知らせの 1 行と、保存するイベントの大きさのため） */
export function toException(err: unknown): ExceptionInfo {
  if (err && typeof err === "object" && typeof (err as Error).message === "string") {
    const e = err as Error;
    return {
      name: typeof e.name === "string" && e.name ? e.name.slice(0, MAX_ERROR_NAME) : "Error",
      message: e.message.slice(0, MAX_ERROR_MESSAGE),
      stack: typeof e.stack === "string" ? workerStack(e.stack).slice(0, MAX_ERROR_STACK) : null,
    };
  }
  let message: string;
  try {
    message = String(err);
  } catch {
    message = "Worker threw exception";
  }
  return { name: "Error", message: message.slice(0, MAX_ERROR_MESSAGE), stack: null };
}

export class Invocation {
  readonly worker: string;
  readonly release: string;
  readonly start = Date.now();
  readonly startedAt = performance.now();
  kind: "worker" | "asset" = "asset";
  outcome: Outcome = "ok";
  detail: Detail;
  method: string;
  path: string;

  constructor(worker: string, release: string, request: Request, pathWithSearch: string) {
    this.worker = worker;
    this.release = release;
    this.method = request.method;
    this.path = pathWithSearch.slice(0, MAX_PATH);
    const headers: Record<string, string> = {};
    for (const h of REQUEST_HEADERS) {
      const v = request.headers.get(h);
      if (v !== null) headers[h] = v;
    }
    this.detail = { url: request.url, request: headers, response: {}, logs: [], droppedLogs: 0, exceptions: [], subrequests: [] };
  }

  log(level: LogLevel, args: unknown[]): void {
    if (this.detail.logs.length >= MAX_LOGS) {
      this.detail.droppedLogs++;
      return;
    }
    this.detail.logs.push({ ts: Date.now(), level, message: format(...args).slice(0, MAX_MESSAGE) });
  }

  exception(err: unknown): void {
    if (this.detail.exceptions.length < MAX_EXCEPTIONS) this.detail.exceptions.push(toException(err));
  }

  subrequest(entry: Detail["subrequests"][number]): void {
    if (this.detail.subrequests.length < MAX_SUBREQUESTS) this.detail.subrequests.push(entry);
  }

  /**
   * 子プロセスで動いた Worker のログ・例外・サブリクエストを取り込む。子は信頼できないので、
   * 形と件数・長さを確かめ、ここで直接記録したときと同じ上限に収める
   */
  merge(raw: unknown): void {
    if (!raw || typeof raw !== "object") return;
    const d = raw as Record<string, unknown>;
    // 文字列以外は使わない（String() で変換すると、細工した値で例外になることがある）
    const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    if (Array.isArray(d.logs)) {
      for (const log of d.logs.slice(0, MAX_LOGS * 2)) {
        if (!log || typeof log !== "object") continue;
        const l = log as Record<string, unknown>;
        if (this.detail.logs.length >= MAX_LOGS) {
          this.detail.droppedLogs++;
          continue;
        }
        const level = (["log", "info", "warn", "error", "debug"] as const).find((x) => x === l.level) ?? "log";
        this.detail.logs.push({ ts: num(l.ts) || Date.now(), level, message: str(l.message, MAX_MESSAGE) });
      }
    }
    this.detail.droppedLogs += Math.min(Math.max(0, Math.floor(num(d.droppedLogs))), 1_000_000);
    if (Array.isArray(d.exceptions)) {
      for (const e of d.exceptions.slice(0, MAX_EXCEPTIONS)) {
        if (!e || typeof e !== "object" || this.detail.exceptions.length >= MAX_EXCEPTIONS) continue;
        const x = e as Record<string, unknown>;
        this.detail.exceptions.push({
          name: str(x.name, 200) || "Error",
          message: str(x.message, MAX_MESSAGE),
          stack: typeof x.stack === "string" ? x.stack.slice(0, MAX_MESSAGE * 4) : null,
        });
      }
    }
    if (Array.isArray(d.subrequests)) {
      for (const s of d.subrequests.slice(0, MAX_SUBREQUESTS)) {
        if (!s || typeof s !== "object") continue;
        const x = s as Record<string, unknown>;
        this.subrequest({
          ts: num(x.ts),
          method: str(x.method, 16),
          url: str(x.url, MAX_PATH * 2),
          status: typeof x.status === "number" && Number.isFinite(x.status) ? x.status : null,
          durationMs: num(x.durationMs),
          error: typeof x.error === "string" ? x.error.slice(0, MAX_MESSAGE) : null,
        });
      }
    }
  }

  response(response: Response): void {
    for (const h of RESPONSE_HEADERS) {
      const v = response.headers.get(h);
      if (v !== null) this.detail.response[h] = v;
    }
  }
}

const storage = new AsyncLocalStorage<Invocation>();

export function currentInvocation(): Invocation | undefined {
  return storage.getStore();
}

export function runInvocation<T>(invocation: Invocation, fn: () => T): T {
  return storage.run(invocation, fn);
}

interface EventRow {
  id: number;
  ts: number;
  kind: string;
  release: string | null;
  method: string;
  path: string;
  status: number;
  outcome: Outcome;
  duration_ms: number;
  log_count: number;
  error: string | null;
}

export interface EventQuery {
  before?: number;
  after?: number;
  limit?: number;
  result?: "ok" | "error";
  kind?: "worker" | "asset";
  q?: string;
  from?: number;
}

const BUCKETS: Record<string, { range: number; step: number }> = {
  "1h": { range: 60 * 60_000, step: 60_000 },
  "24h": { range: 24 * 60 * 60_000, step: 30 * 60_000 },
  "3d": { range: 3 * 24 * 60 * 60_000, step: 2 * 60 * 60_000 },
};

/** 検索で 1 件の detail のうち見る長さ（ログが大きいイベントが並んでも、検索 1 回で読む量を抑える） */
const SEARCH_DETAIL_CHARS = 32 * 1024;

/** n 件を並べたうちの q の位置（JS で sorted[min(n - 1, floor(n * q))] と同じ）。r は ROW_NUMBER() - 1 の i と件数 n を持つ */
const percentileSql = (q: number) => `MAX(CASE WHEN i = MIN(n - 1, CAST(n * ${q} AS INTEGER)) THEN d END)`;

export interface ObservabilityLimits {
  /** サイトごとに残すイベントの数 */
  perSite: number;
  /** events.sqlite の使っている大きさの上限（バイト） */
  maxBytes: number;
}

const DEFAULT_LIMITS: ObservabilityLimits = { perSite: 10_000, maxBytes: 256 * 1024 * 1024 };

export class Observability {
  #db: DatabaseSync;
  #queue: { invocation: Invocation; status: number; duration: number }[] = [];
  #insert: StatementSync;
  #timer: NodeJS.Timeout;
  #retentionMs: number;
  #limits: ObservabilityLimits;
  /** 前に上限を確かめてから記録したサイト（全サイトを毎回数えない） */
  #written = new Set<string>();

  constructor(db: DatabaseSync, retentionHours: number, limits: Partial<ObservabilityLimits> = {}) {
    this.#db = db;
    this.#retentionMs = retentionHours * 60 * 60_000;
    this.#limits = { ...DEFAULT_LIMITS, ...limits };
    this.#insert = db.prepare(
      `INSERT INTO events (site, ts, kind, release, method, path, status, outcome, duration_ms, log_count, error, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let ticks = 0;
    this.#timer = setInterval(() => {
      this.flush();
      // 保持期間だけだと、リクエストを大量に送られたときに数日分がたまり続ける。件数と大きさでも削る
      if (++ticks % 10 === 0) this.enforceLimits();
      if (ticks % 600 === 0) this.prune();
    }, 1000);
    this.#timer.unref();
  }

  record(invocation: Invocation, status: number, duration: number): void {
    this.#queue.push({ invocation, status, duration });
    if (this.#queue.length >= 200) this.flush();
  }

  flush(): void {
    if (!this.#queue.length) return;
    const queue = this.#queue;
    this.#queue = [];
    try {
      this.#db.exec("BEGIN");
      for (const { invocation: inv, status, duration } of queue) {
        this.#written.add(inv.worker);
        const error = inv.detail.exceptions[0] ? `${inv.detail.exceptions[0].name}: ${inv.detail.exceptions[0].message}` : null;
        this.#insert.run(
          inv.worker,
          inv.start,
          inv.kind,
          inv.release,
          inv.method,
          inv.path,
          status,
          inv.outcome,
          Math.round(duration * 100) / 100,
          inv.detail.logs.length + inv.detail.droppedLogs,
          error,
          JSON.stringify(inv.detail),
        );
      }
      this.#db.exec("COMMIT");
    } catch (err) {
      // ディスクがいっぱいのときなど。SQLite が自分でロールバックしていることがあるので、トランザクション中のときだけ戻す。
      // 記録できなかったイベントは捨てる（タイマーから呼ばれるので、ここで例外を投げると本体ごと落ちる）
      try {
        if (this.#db.isTransaction) this.#db.exec("ROLLBACK");
      } catch {}
      console.error("[kanzume] イベントの保存に失敗:", (err as Error)?.message ?? err);
    }
  }

  prune(now = Date.now()): void {
    try {
      this.#db.prepare("DELETE FROM events WHERE ts < ?").run(now - this.#retentionMs);
    } catch (err) {
      console.error("[kanzume] 古いイベントを消せませんでした:", (err as Error)?.message ?? err);
    }
  }

  /**
   * サイトごとの件数と、DB 全体の大きさの上限を超えた分を古い方から消す。
   * 件数は新しい方から perSite 件目の id より前を消す（インデックスを perSite 件たどるだけで、数え直さない）。
   * 大きさは空きページを除いたページ数で見て、超えていれば古い方から 1 割ずつ消す
   */
  enforceLimits(): void {
    try {
      this.flush();
      const sites = [...this.#written];
      this.#written.clear();
      const trim = this.#db.prepare("DELETE FROM events WHERE site = ? AND id <= (SELECT id FROM events WHERE site = ? ORDER BY id DESC LIMIT 1 OFFSET ?)");
      for (const site of sites) trim.run(site, site, this.#limits.perSite);
      const pragma = (name: string) => Number((this.#db.prepare(`PRAGMA ${name}`).get() as Record<string, number>)[name]);
      for (let i = 0; i < 5; i++) {
        const used = (pragma("page_count") - pragma("freelist_count")) * pragma("page_size");
        if (used <= this.#limits.maxBytes) break;
        const { lo, hi } = this.#db.prepare("SELECT MIN(id) AS lo, MAX(id) AS hi FROM events").get() as { lo: number | null; hi: number | null };
        if (lo === null || hi === null) break;
        // 超えた割合より 1 割多く、古い方から消す（id はほぼ連続なので、範囲の割合で行数の割合を近似する）
        const ratio = Math.min(1, (used - this.#limits.maxBytes) / used + 0.1);
        this.#db.prepare("DELETE FROM events WHERE id <= ?").run(lo + Math.ceil((hi - lo) * ratio));
      }
    } catch (err) {
      console.error("[kanzume] イベントを上限まで減らせませんでした:", (err as Error)?.message ?? err);
    }
  }

  clear(site: string): void {
    this.flush();
    this.#db.prepare("DELETE FROM events WHERE site = ?").run(site);
  }

  events(site: string, query: EventQuery = {}) {
    this.flush();
    const where = ["site = ?"];
    const params: (string | number)[] = [site];
    if (query.before) {
      where.push("id < ?");
      params.push(query.before);
    }
    if (query.after) {
      where.push("id > ?");
      params.push(query.after);
    }
    if (query.from) {
      where.push("ts >= ?");
      params.push(query.from);
    }
    if (query.kind) {
      where.push("kind = ?");
      params.push(query.kind);
    }
    if (query.result === "error") where.push("(status >= 500 OR outcome != 'ok')");
    if (query.result === "ok") where.push("(status < 500 AND outcome = 'ok')");
    if (query.q) {
      where.push(`(instr(lower(path), ?) > 0 OR instr(lower(substr(detail, 1, ${SEARCH_DETAIL_CHARS})), ?) > 0)`);
      params.push(query.q.toLowerCase(), query.q.toLowerCase());
    }
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    // after（ライブ表示の続き）は古い方から取る（新しい方から取ると、間に来た分を飛ばしてしまう）。返すのはどちらも新しい順
    const order = query.after && !query.before ? "ASC" : "DESC";
    const rows = this.#db
      .prepare(
        `SELECT id, ts, kind, release, method, path, status, outcome, duration_ms, log_count, error FROM events
         WHERE ${where.join(" AND ")} ORDER BY id ${order} LIMIT ?`,
      )
      .all(...params, limit) as unknown as EventRow[];
    if (order === "ASC") rows.reverse();
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      kind: r.kind,
      release: r.release,
      method: r.method,
      path: r.path,
      status: r.status,
      outcome: r.outcome,
      durationMs: r.duration_ms,
      logCount: r.log_count,
      error: r.error,
    }));
  }

  event(site: string, id: number) {
    this.flush();
    const row = this.#db.prepare("SELECT * FROM events WHERE site = ? AND id = ?").get(site, id) as (EventRow & { detail: string }) | undefined;
    if (!row) return null;
    return {
      id: row.id,
      ts: row.ts,
      kind: row.kind,
      release: row.release,
      method: row.method,
      path: row.path,
      status: row.status,
      outcome: row.outcome,
      durationMs: row.duration_ms,
      logCount: row.log_count,
      error: row.error,
      detail: JSON.parse(row.detail) as Detail,
    };
  }

  metrics(site: string, range: string, now = Date.now()) {
    this.flush();
    const { range: span, step } = BUCKETS[range] ?? BUCKETS["24h"];
    const end = Math.ceil(now / step) * step;
    const start = end - span;
    const count = span / step;
    // 行を JS に持ってこず、集計と百分位は SQLite の中で出す（件数が多いと、全行の配列とソートで本体が止まり、メモリも使う）
    const isError = "(status >= 500 OR outcome != 'ok')";
    const t = this.#db
      .prepare(
        `WITH r AS (
           SELECT duration_ms AS d, status, outcome, kind, ROW_NUMBER() OVER (ORDER BY duration_ms) - 1 AS i, COUNT(*) OVER () AS n
           FROM events WHERE site = ? AND ts >= ?
         )
         SELECT COUNT(*) AS requests, SUM(kind = 'worker') AS worker, SUM(${isError}) AS errors,
           SUM(status >= 200 AND status < 300) AS s2, SUM(status >= 300 AND status < 400) AS s3,
           SUM(status >= 400 AND status < 500) AS s4, SUM(status >= 500 AND status < 600) AS s5,
           ${percentileSql(0.5)} AS p50, ${percentileSql(0.95)} AS p95, ${percentileSql(0.99)} AS p99
         FROM r`,
      )
      .get(site, start) as Record<string, number | null>;
    const rows = this.#db
      .prepare(
        `WITH e AS (
           SELECT MIN(?, CAST((ts - ?) / ? AS INTEGER)) AS b, duration_ms AS d, ${isError} AS err FROM events WHERE site = ? AND ts >= ?
         ), r AS (
           SELECT b, d, err, ROW_NUMBER() OVER (PARTITION BY b ORDER BY d) - 1 AS i, COUNT(*) OVER (PARTITION BY b) AS n FROM e
         )
         SELECT b, SUM(err) AS errors, COUNT(*) - SUM(err) AS ok, ${percentileSql(0.5)} AS p50, ${percentileSql(0.99)} AS p99 FROM r GROUP BY b`,
      )
      .all(count - 1, start, step, site, start) as { b: number; errors: number; ok: number; p50: number | null; p99: number | null }[];
    const byBucket = new Map(rows.map((r) => [r.b, r]));
    return {
      range,
      step,
      start,
      end,
      totals: {
        requests: t.requests ?? 0,
        worker: t.worker ?? 0,
        errors: t.errors ?? 0,
        p50: t.p50,
        p95: t.p95,
        p99: t.p99,
        statuses: { "2xx": t.s2 ?? 0, "3xx": t.s3 ?? 0, "4xx": t.s4 ?? 0, "5xx": t.s5 ?? 0 },
      },
      buckets: Array.from({ length: count }, (_, i) => {
        const b = byBucket.get(i);
        return { t: start + i * step, ok: b?.ok ?? 0, errors: b?.errors ?? 0, p50: b?.p50 ?? null, p99: b?.p99 ?? null };
      }),
    };
  }

  close(): void {
    clearInterval(this.#timer);
    this.flush();
  }
}
