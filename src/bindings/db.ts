import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS kv (
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  value BLOB NOT NULL,
  metadata TEXT,
  expiration INTEGER,
  PRIMARY KEY (namespace, key)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS r2 (
  bucket TEXT NOT NULL,
  key TEXT NOT NULL,
  version TEXT NOT NULL,
  size INTEGER NOT NULL,
  etag TEXT NOT NULL,
  uploaded INTEGER NOT NULL,
  http_metadata TEXT NOT NULL,
  custom_metadata TEXT NOT NULL,
  PRIMARY KEY (bucket, key)
) WITHOUT ROWID;
`;

const open = new Map<string, DatabaseSync>();

export function siteDb(siteDir: string): DatabaseSync {
  let db = open.get(siteDir);
  if (!db) {
    fs.mkdirSync(siteDir, { recursive: true });
    db = new DatabaseSync(path.join(siteDir, "data.sqlite"));
    db.exec(SCHEMA);
    open.set(siteDir, db);
  }
  return db;
}

export function closeSiteDb(siteDir: string): void {
  open.get(siteDir)?.close();
  open.delete(siteDir);
}
