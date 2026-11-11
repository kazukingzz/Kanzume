import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { siteDataDir } from "../layout.ts";

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
let busyTimeoutMs = 200;

/** ロックを待つ時間（Worker の子プロセスでは長くする） */
export function setBusyTimeout(ms: number): void {
  busyTimeoutMs = ms;
}

export { siteDataDir };

/** data/ を作る。サイトのディレクトリが消されていたら作り直さない（ENOENT になる） */
export function ensureSiteDataDir(siteDir: string): void {
  try {
    fs.mkdirSync(siteDataDir(siteDir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
}

export function siteDb(siteDir: string): DatabaseSync {
  let db = open.get(siteDir);
  if (!db) {
    ensureSiteDataDir(siteDir);
    db = new DatabaseSync(path.join(siteDataDir(siteDir), "data.sqlite"));
    // Worker の子プロセスと本体（管理画面のデータタブ）が同時に書くことがあるので、ロックを少し待つ。
    // DatabaseSync は待つ間イベントループを止めるので、全サイトを配信する本体では短くし、子だけ長く待つ（setBusyTimeout）
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
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
