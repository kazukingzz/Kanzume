import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS deployments (
  id TEXT PRIMARY KEY,
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
CREATE INDEX IF NOT EXISTS deployments_created ON deployments (created_at);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
`;

export function openMetaDb(dataDir: string): DatabaseSync {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "meta.sqlite"));
  db.exec(SCHEMA);
  return db;
}
