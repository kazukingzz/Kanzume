import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EVENTS_DB, META_DB } from "../layout.ts";

/** デプロイの履歴（バックアップする） */
const META_SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS deployments (
  id TEXT PRIMARY KEY,
  site TEXT NOT NULL,
  name TEXT NOT NULL,
  release TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  duration_ms INTEGER,
  size INTEGER,
  files INTEGER,
  error TEXT,
  meta TEXT NOT NULL,
  log TEXT NOT NULL,
  build_log TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS deployments_site_created ON deployments (site, created_at);
CREATE INDEX IF NOT EXISTS deployments_release ON deployments (release);
`;

/** リクエストのログ（可観測性）。リクエストのたびに書き換わり、数日で消えるのでバックアップしない */
const EVENTS_SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site TEXT NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  release TEXT,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  duration_ms REAL NOT NULL,
  log_count INTEGER NOT NULL,
  error TEXT,
  detail TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_ts ON events (ts);
CREATE INDEX IF NOT EXISTS events_site_id ON events (site, id);
CREATE INDEX IF NOT EXISTS events_site_ts ON events (site, ts);
`;

export function openMetaDb(dataDir: string): DatabaseSync {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, META_DB));
  db.exec(META_SCHEMA);
  return db;
}

/**
 * ログの DB を開く。以前は meta.sqlite に入れていたので、残っていれば移して消す
 * （meta.sqlite はバックアップするので、リクエストのたびに変わるログを入れておくと毎回大きなファイルを送ることになる）
 */
export function openEventsDb(dataDir: string, meta: DatabaseSync): DatabaseSync {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, EVENTS_DB);
  const db = new DatabaseSync(file);
  db.exec(EVENTS_SCHEMA);
  const legacy = meta.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events'").get();
  if (legacy) {
    try {
      meta.exec(`ATTACH DATABASE '${file.replace(/'/g, "''")}' AS ev`);
      try {
        meta.exec(`BEGIN;
          INSERT INTO ev.events (site, ts, kind, release, method, path, status, outcome, duration_ms, log_count, error, detail)
            SELECT site, ts, kind, release, method, path, status, outcome, duration_ms, log_count, error, detail FROM main.events ORDER BY id;
          DROP TABLE main.events;
          COMMIT;`);
      } catch (err) {
        if (meta.isTransaction) meta.exec("ROLLBACK");
        throw err;
      } finally {
        meta.exec("DETACH DATABASE ev");
      }
      meta.exec("VACUUM");
    } catch (err) {
      console.error("[kanzume] 以前のログを移せませんでした:", (err as Error)?.message ?? err);
    }
  }
  return db;
}
