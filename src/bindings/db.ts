import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { siteDataDir } from "../layout.ts";
import { UserFacingError } from "../errors.ts";

const TABLES = `
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

// trusted_schema: 子が書き換えたビューやトリガーから、副作用のある関数を呼ばせない（形の確認とあわせた二重の備え）
const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA trusted_schema = OFF;
${TABLES}`;

/** data.sqlite の形が想定と違う（Worker の子プロセスがビューやトリガーに差し替えたなど） */
export class SiteDataError extends UserFacingError {
  constructor(detail: string) {
    super(`サイトのデータベース（data.sqlite）の形が想定と違うため、開けません（${detail}）。Worker が書き換えた可能性があります`, 409);
  }
}

/** 想定する sqlite_master の中身。SQL の文面は SQLite が整えたものと比べるので、同じ文から作る */
const EXPECTED_SCHEMA: Map<string, string> = (() => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(TABLES);
    const rows = db.prepare("SELECT name, sql FROM sqlite_master").all() as { name: string; sql: string }[];
    return new Map(rows.map((r) => [r.name, r.sql]));
  } finally {
    db.close();
  }
})();

/**
 * data.sqlite の中身が kv と r2 の 2 つのテーブルだけかを確かめる。子プロセスは DB を自由に書き換えられるので、
 * 同じ名前のビュー（終わらない再帰の CTE で本体を止める）や、本体の書き込みで動くトリガー・式のインデックスを置けば、
 * 本体の問い合わせがそれを通ってしまう。CREATE TABLE IF NOT EXISTS は同じ名前のビューがあっても何もしないので、ここで弾く。
 * 読むのは 1 件多めまで（数を絞らずに読むと、大量のオブジェクトを並べられたときに遅くなる）
 */
export function verifySiteSchema(db: DatabaseSync): void {
  const rows = db.prepare("SELECT type, name, sql FROM sqlite_master LIMIT ?").all(EXPECTED_SCHEMA.size + 1) as {
    type: unknown;
    name: unknown;
    sql: unknown;
  }[];
  if (rows.length !== EXPECTED_SCHEMA.size) throw new SiteDataError("テーブル以外のオブジェクトがあります");
  for (const row of rows) {
    const expected = typeof row.name === "string" ? EXPECTED_SCHEMA.get(row.name) : undefined;
    if (row.type !== "table" || expected === undefined || row.sql !== expected) throw new SiteDataError(`${String(row.name).slice(0, 64)} が想定と違います`);
  }
}

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

/**
 * キャッシュしない接続を開く。本体の管理画面のデータタブは、読むたび・書くたびにこれで開いて閉じる
 * （キャッシュした接続は inline の Worker やバックアップと共有しており、トランザクションを張ると巻き込むため）
 */
export function openSiteDb(siteDir: string, { readOnly }: { readOnly: boolean }): DatabaseSync {
  if (!readOnly) ensureSiteDataDir(siteDir);
  const db = new DatabaseSync(path.join(siteDataDir(siteDir), "data.sqlite"), { readOnly });
  try {
    // Worker の子プロセスと本体（管理画面のデータタブ）が同時に書くことがあるので、ロックを少し待つ。
    // DatabaseSync は待つ間イベントループを止めるので、全サイトを配信する本体では短くし、子だけ長く待つ（setBusyTimeout）
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    db.exec(readOnly ? "PRAGMA trusted_schema = OFF" : SCHEMA);
    verifySiteSchema(db);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

export function siteDb(siteDir: string): DatabaseSync {
  let db = open.get(siteDir);
  if (!db) {
    db = openSiteDb(siteDir, { readOnly: false });
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
