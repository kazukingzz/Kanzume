import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { format } from "node:util";

export type Outcome = "ok" | "exception" | "exceededCpu" | "canceled";
export type LogLevel = "log" | "info" | "warn" | "error" | "debug";

const MAX_LOGS = 100;
const MAX_MESSAGE = 4096;
const MAX_SUBREQUESTS = 50;
const MAX_PATH = 1024;

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

export function toException(err: unknown): ExceptionInfo {
  if (err && typeof err === "object" && typeof (err as Error).message === "string") {
    const e = err as Error;
    return { name: e.name || "Error", message: e.message, stack: typeof e.stack === "string" ? workerStack(e.stack) : null };
  }
  return { name: "Error", message: String(err), stack: null };
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
    this.detail.exceptions.push(toException(err));
  }

  subrequest(entry: Detail["subrequests"][number]): void {
    if (this.detail.subrequests.length < MAX_SUBREQUESTS) this.detail.subrequests.push(entry);
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

function percentile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

const isError = (status: number, outcome: string) => status >= 500 || outcome !== "ok";

export class Observability {
  #db: DatabaseSync;
  #queue: { invocation: Invocation; status: number; duration: number }[] = [];
  #insert: StatementSync;
  #timer: NodeJS.Timeout;
  #retentionMs: number;

  constructor(db: DatabaseSync, retentionHours: number) {
    this.#db = db;
    this.#retentionMs = retentionHours * 60 * 60_000;
    this.#insert = db.prepare(
      `INSERT INTO events (ts, kind, release, method, path, status, outcome, duration_ms, log_count, error, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let ticks = 0;
    this.#timer = setInterval(() => {
      this.flush();
      if (++ticks % 600 === 0) this.prune();
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
    this.#db.exec("BEGIN");
    try {
      for (const { invocation: inv, status, duration } of queue) {
        const error = inv.detail.exceptions[0] ? `${inv.detail.exceptions[0].name}: ${inv.detail.exceptions[0].message}` : null;
        this.#insert.run(
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
      this.#db.exec("ROLLBACK");
      console.error("[kanzume] イベントの保存に失敗:", err);
    }
  }

  prune(now = Date.now()): void {
    this.#db.prepare("DELETE FROM events WHERE ts < ?").run(now - this.#retentionMs);
  }

  clear(): void {
    this.#queue = [];
    this.#db.prepare("DELETE FROM events").run();
  }

  events(query: EventQuery = {}) {
    this.flush();
    const where = ["1 = 1"];
    const params: (string | number)[] = [];
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
      where.push("(instr(lower(path), ?) > 0 OR instr(lower(detail), ?) > 0)");
      params.push(query.q.toLowerCase(), query.q.toLowerCase());
    }
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const rows = this.#db
      .prepare(
        `SELECT id, ts, kind, release, method, path, status, outcome, duration_ms, log_count, error FROM events
         WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`,
      )
      .all(...params, limit) as unknown as EventRow[];
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

  event(id: number) {
    this.flush();
    const row = this.#db.prepare("SELECT * FROM events WHERE id = ?").get(id) as
      | (EventRow & { detail: string })
      | undefined;
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

  metrics(range: string, now = Date.now()) {
    this.flush();
    const { range: span, step } = BUCKETS[range] ?? BUCKETS["24h"];
    const end = Math.ceil(now / step) * step;
    const start = end - span;
    const rows = this.#db
      .prepare("SELECT ts, status, outcome, duration_ms, kind FROM events WHERE ts >= ? ORDER BY ts")
      .all(start) as { ts: number; status: number; outcome: string; duration_ms: number; kind: string }[];

    const count = span / step;
    const buckets = Array.from({ length: count }, (_, i) => ({ t: start + i * step, ok: 0, errors: 0, durations: [] as number[] }));
    const all: number[] = [];
    const statuses: Record<string, number> = { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 };
    let errors = 0;
    let worker = 0;
    for (const r of rows) {
      const b = buckets[Math.min(count - 1, Math.floor((r.ts - start) / step))];
      if (isError(r.status, r.outcome)) {
        b.errors++;
        errors++;
      } else {
        b.ok++;
      }
      b.durations.push(r.duration_ms);
      all.push(r.duration_ms);
      const cls = `${Math.floor(r.status / 100)}xx`;
      if (cls in statuses) statuses[cls]++;
      if (r.kind === "worker") worker++;
    }
    all.sort((a, b) => a - b);
    return {
      range,
      step,
      start,
      end,
      totals: {
        requests: rows.length,
        worker,
        errors,
        p50: percentile(all, 0.5),
        p95: percentile(all, 0.95),
        p99: percentile(all, 0.99),
        statuses,
      },
      buckets: buckets.map((b) => {
        const d = b.durations.sort((x, y) => x - y);
        return { t: b.t, ok: b.ok, errors: b.errors, p50: percentile(d, 0.5), p99: percentile(d, 0.99) };
      }),
    };
  }

  close(): void {
    clearInterval(this.#timer);
    this.flush();
  }
}
