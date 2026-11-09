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

/**
 * サイトの KV / R2 の置き場所（<siteDir>/data）。Worker の子プロセスが書き込めるのはここだけ
 * （サイトのディレクトリのほかの場所、settings.json やリリースには書かせない）
 */
export const siteDataDir = (siteDir: string) => path.join(siteDir, "data");

export function siteDb(siteDir: string): DatabaseSync {
  let db = open.get(siteDir);
  if (!db) {
    fs.mkdirSync(siteDataDir(siteDir), { recursive: true });
    db = new DatabaseSync(path.join(siteDataDir(siteDir), "data.sqlite"));
    // Worker の子プロセスと本体（管理画面のデータタブ）が同時に書くことがあるので、ロックを少し待つ
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(SCHEMA);
    open.set(siteDir, db);
  }
  return db;
}

/** 開いている接続があれば返す（開いていなければ開かない。バックアップがサイトを作り直さないように） */
export function openedSiteDb(siteDir: string): DatabaseSync | undefined {
  return open.get(siteDir);
}

export function closeAllSiteDbs(): void {
  for (const db of open.values()) db.close();
  open.clear();
}

export function closeSiteDb(siteDir: string): void {
  open.get(siteDir)?.close();
  open.delete(siteDir);
}
