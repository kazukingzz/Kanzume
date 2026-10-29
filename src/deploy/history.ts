import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface DeploySource {
  repository?: string;
  ref?: string;
  sha?: string;
  actor?: string;
  commitMessage?: string;
  runUrl?: string;
  serverUrl?: string;
}

export interface DeploymentInput {
  id?: string;
  name: string;
  release: string | null;
  status: "success" | "failed";
  durationMs: number;
  size: number;
  files: number;
  error: string | null;
  source: DeploySource;
  log: string;
  buildLog: string;
}

interface Row {
  id: string;
  name: string;
  release: string | null;
  status: "success" | "failed";
  created_at: number;
  duration_ms: number;
  size: number;
  files: number;
  error: string | null;
  meta: string;
  log: string;
  build_log: string;
}

const MAX_LOG = 256 * 1024;
const KEEP = 50;

const SOURCE_KEYS = ["repository", "ref", "sha", "actor", "commitMessage", "runUrl", "serverUrl"] as const;

export function sanitizeSource(input: unknown): DeploySource {
  const out: DeploySource = {};
  if (!input || typeof input !== "object") return out;
  for (const key of SOURCE_KEYS) {
    const v = (input as Record<string, unknown>)[key];
    if (typeof v === "string" && v) out[key] = v.slice(0, 500);
  }
  return out;
}

export function newDeploymentId(): string {
  return `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

function summary(r: Row) {
  return {
    id: r.id,
    name: r.name,
    release: r.release,
    status: r.status,
    createdAt: new Date(r.created_at).toISOString(),
    durationMs: r.duration_ms,
    size: r.size,
    files: r.files,
    error: r.error,
    source: JSON.parse(r.meta) as DeploySource,
  };
}

export class DeployHistory {
  #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  add(input: DeploymentInput): string {
    const id = input.id ?? newDeploymentId();
    this.#db
      .prepare(
        `INSERT INTO deployments (id, name, release, status, created_at, duration_ms, size, files, error, meta, log, build_log)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.release,
        input.status,
        Date.now(),
        Math.round(input.durationMs),
        input.size,
        input.files,
        input.error,
        JSON.stringify(input.source),
        input.log.slice(-MAX_LOG),
        input.buildLog.slice(-MAX_LOG),
      );
    this.#db
      .prepare("DELETE FROM deployments WHERE id NOT IN (SELECT id FROM deployments ORDER BY created_at DESC, id DESC LIMIT ?)")
      .run(KEEP);
    return id;
  }

  list() {
    const rows = this.#db.prepare("SELECT * FROM deployments ORDER BY created_at DESC, id DESC").all() as unknown as Row[];
    return rows.map(summary);
  }

  get(id: string) {
    const row = this.#db.prepare("SELECT * FROM deployments WHERE id = ?").get(id) as Row | undefined;
    return row ? { ...summary(row), log: row.log, buildLog: row.build_log } : null;
  }

  latest() {
    const row = this.#db.prepare("SELECT * FROM deployments ORDER BY created_at DESC, id DESC LIMIT 1").get() as Row | undefined;
    return row ? summary(row) : null;
  }

  forRelease(release: string) {
    const row = this.#db.prepare("SELECT * FROM deployments WHERE release = ?").get(release) as Row | undefined;
    return row ? summary(row) : null;
  }

  clear(): void {
    this.#db.prepare("DELETE FROM deployments").run();
  }
}
