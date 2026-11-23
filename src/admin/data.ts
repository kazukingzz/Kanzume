import { constants as fsConstants } from "node:fs";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { openSiteDb, SiteDataError, siteDataDir, verifySiteSchema } from "../bindings/db.ts";
import { KVNamespace } from "../bindings/kv.ts";
import { R2_BUCKET_NAME, R2Bucket } from "../bindings/r2.ts";
import { BINDING_NAME } from "../deploy/wrangler.ts";
import { SerialQueue } from "../serial.ts";
import type { Release } from "../store.ts";

/**
 * 管理画面の「データベース」（KV）と「ストレージ」（R2）タブ用の読み書き。
 * data.sqlite は Worker の子プロセスが自由に書き換えられるので、本体（全サイトの配信を受け持つ）からは次のように扱う。
 * - 読むときは使い捨ての読み取り専用の接続で、1 つの読み取りトランザクションの中で形を確かめてから読む（間に子が形を変えても見えない）
 * - 値の大きさは SQL の中で確かめ、大きすぎるものは JS に持ってこない（octet_length は中身を読まずに長さを返す）
 * - 件数を数えるときも上限で止める
 * 書き込みは Worker と同じ KVNamespace / R2Bucket を通す（R2 のファイルとメタデータの整合を保つため）
 */

const PAGE = 100;
const PREVIEW_BYTES = 256 * 1024;
/** 一覧に出す名前空間・バケットの数と、数える件数の上限（それ以上は「以上」と出す） */
const MAX_NAMES = 50;
const COUNT_CAP = 10_000;
/** KV の値をプレビューのために読み込む上限。バインディングの上限（25 MiB）を超える値は子が直接書いたものなので読まない */
const MAX_KV_VALUE = 25 * 1024 * 1024;
const MAX_KV_KEY = 512;
const MAX_KV_METADATA = 1024;
const MAX_R2_KEY = 1024;
const MAX_R2_METADATA = 8 * 1024;
const now = () => Math.floor(Date.now() / 1000);

const dbFile = (siteDir: string) => path.join(siteDataDir(siteDir), "data.sqlite");

/** まだ一度も KV / R2 を使っていないサイトでは data.sqlite を作らない（empty を返す） */
function read<T>(siteDir: string, empty: T, fn: (db: DatabaseSync) => T): T {
  if (!fs.existsSync(dbFile(siteDir))) return empty;
  const db = openSiteDb(siteDir, { readOnly: true });
  try {
    db.exec("BEGIN");
    try {
      verifySiteSchema(db);
      return fn(db);
    } finally {
      db.exec("COMMIT");
    }
  } finally {
    db.close();
  }
}

const writes = new SerialQueue();

/**
 * 書き込みは使い捨ての接続で、書き込みのロックを取ってから形を確かめる（ロックを持つ間は子が形を変えられない）。
 * 同じサイトへの書き込みは順番にする（同時に BEGIN IMMEDIATE すると、ロックを待つ間イベントループが止まる）
 */
function write<T>(siteDir: string, fn: (db: DatabaseSync) => Promise<T>): Promise<T> {
  return writes.run(siteDir, async () => {
    const db = openSiteDb(siteDir, { readOnly: false });
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        verifySiteSchema(db);
        const result = await fn(db);
        db.exec("COMMIT");
        return result;
      } catch (err) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw err;
      }
    } finally {
      db.close();
    }
  });
}

/**
 * prefix で始まる文字列の上限（これより小さい）。TEXT は UTF-8 のバイト列で比べるので、最後のバイトを 1 つ増やす
 * （UTF-8 に 0xFF は現れないので繰り上がらない）。instr(key, prefix) = 1 だけで絞ると、名前空間の全件を読むことになる
 */
function prefixEnd(prefix: string): Uint8Array {
  const bytes = new Uint8Array(Buffer.from(prefix, "utf8"));
  bytes[bytes.length - 1]++;
  return bytes;
}

/** prefix の範囲の条件（キーの列 col）。空なら全部 */
function prefixRange(col: string, prefix: string): { sql: string; params: SQLInputValue[] } {
  if (!prefix) return { sql: "1", params: [] };
  return { sql: `${col} >= ? AND ${col} < CAST(? AS TEXT)`, params: [prefix, prefixEnd(prefix)] };
}

/**
 * 列 col の値の種類を、インデックスをたどって飛ばしながら集める（GROUP BY は全行を読むので使わない）。
 * 長すぎる・名前の規則に合わない値は飛ばす。行が大量にあっても、問い合わせは集める数に比例する回数で済む
 */
function distinctNames(db: DatabaseSync, table: "kv" | "r2", col: "namespace" | "bucket", valid: RegExp): string[] {
  const maxChars = 64;
  const next = db.prepare(`SELECT substr(${col}, 1, ${maxChars + 1}) AS v, typeof(${col}) AS t FROM ${table} WHERE ${col} > ? ORDER BY ${col} LIMIT 1`);
  const skip = db.prepare(
    `SELECT substr(${col}, 1, ${maxChars + 1}) AS v, typeof(${col}) AS t FROM ${table} WHERE ${col} >= CAST(? AS TEXT) ORDER BY ${col} LIMIT 1`,
  );
  const names: string[] = [];
  let row = next.get("") as { v: unknown; t: string } | undefined;
  for (let i = 0; row && i < MAX_NAMES * 4 && names.length < MAX_NAMES; i++) {
    // TEXT 以外（BLOB など）は TEXT より後ろに並ぶので、そこで終わり
    if (row.t !== "text" || typeof row.v !== "string" || row.v === "") break;
    if (row.v.length <= maxChars && valid.test(row.v)) {
      names.push(row.v);
      row = next.get(row.v) as typeof row;
    } else {
      // 先頭が同じ値をまとめて飛ばす
      row = skip.get(prefixEnd(row.v)) as typeof row;
    }
  }
  return names;
}

const parseJson = (s: unknown) => {
  if (typeof s !== "string") return null;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

const parseRecord = (s: unknown): Record<string, unknown> => {
  const v = parseJson(s);
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
};

/**
 * バイト列を文字列として見せられるか（UTF-8 として正しく、NUL を含まない）。
 * truncated なら途中で切ったものなので、末尾で切れた文字（最大 3 バイト）は捨ててから確かめる
 */
export function asText(data: Uint8Array, truncated = false): string | null {
  if (data.includes(0)) return null;
  for (let cut = 0; cut <= (truncated ? 3 : 0); cut++) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, data.length - cut));
    } catch {}
  }
  return null;
}

const capped = (n: number) => ({ count: Math.min(n, COUNT_CAP), ...(n > COUNT_CAP && { countCapped: true }) });

// ---------- KV ----------

/** wrangler の設定にある KV と、データだけが残っている KV（設定から外したもの）の一覧 */
export function kvNamespaces(siteDir: string, release: Release | undefined) {
  const bound = release?.manifest.kvNamespaces.map((k) => k.binding) ?? [];
  type Namespace = { name: string; bound: boolean; count: number; countCapped?: boolean };
  return read<Namespace[]>(
    siteDir,
    bound.map((name) => ({ name, bound: true, count: 0 })),
    (db) => {
      const names = [...new Set([...bound, ...distinctNames(db, "kv", "namespace", BINDING_NAME)])].sort();
      const count = db.prepare("SELECT COUNT(*) AS n FROM (SELECT 1 FROM kv WHERE namespace = ? AND (expiration IS NULL OR expiration > ?) LIMIT ?)");
      return names.map((name) => ({ name, bound: bound.includes(name), ...capped((count.get(name, now(), COUNT_CAP + 1) as { n: number }).n) }));
    },
  ).sort((a, b) => (a.name < b.name ? -1 : 1));
}

export function kvKeys(siteDir: string, namespace: string, prefix: string, after: string) {
  return read(siteDir, { keys: [] as { key: string; size: number; metadata: unknown; expiration: number | null }[], cursor: null as string | null }, (db) => {
    const range = prefixRange("key", prefix);
    const rows = db
      .prepare(
        `SELECT key, octet_length(value) AS size,
           CASE WHEN typeof(metadata) = 'text' AND octet_length(metadata) <= ${MAX_KV_METADATA} THEN metadata END AS metadata,
           CASE WHEN typeof(expiration) = 'integer' THEN expiration END AS expiration
         FROM kv WHERE namespace = ? AND key > ? AND ${range.sql} AND typeof(key) = 'text' AND octet_length(key) <= ${MAX_KV_KEY}
           AND (expiration IS NULL OR expiration > ?) ORDER BY key LIMIT ?`,
      )
      .all(namespace, after, ...range.params, now(), PAGE + 1) as { key: string; size: number; metadata: string | null; expiration: number | null }[];
    const page = rows.slice(0, PAGE);
    return {
      keys: page.map((r) => ({ key: r.key, size: r.size, metadata: parseJson(r.metadata), expiration: r.expiration })),
      cursor: rows.length > PAGE ? page.at(-1)!.key : null,
    };
  });
}

export function kvValue(siteDir: string, namespace: string, key: string) {
  return read(siteDir, null, (db) => {
    const where = "namespace = ? AND key = ? AND (expiration IS NULL OR expiration > ?)";
    const t = now();
    const row = db
      .prepare(
        `SELECT octet_length(value) AS size,
           CASE WHEN typeof(metadata) = 'text' AND octet_length(metadata) <= ${MAX_KV_METADATA} THEN metadata END AS metadata,
           CASE WHEN typeof(expiration) = 'integer' THEN expiration END AS expiration
         FROM kv WHERE ${where}`,
      )
      .get(namespace, key, t) as { size: number; metadata: string | null; expiration: number | null } | undefined;
    if (!row) return null;
    const truncated = row.size > PREVIEW_BYTES;
    let text: string | null = null;
    if (row.size <= MAX_KV_VALUE) {
      const head = db.prepare(`SELECT substr(CAST(value AS BLOB), 1, ?) AS head FROM kv WHERE ${where}`).get(PREVIEW_BYTES, namespace, key, t) as
        | { head: unknown }
        | undefined;
      if (head?.head instanceof Uint8Array) text = asText(head.head, truncated);
    }
    return { key, size: row.size, text, truncated, metadata: parseJson(row.metadata), expiration: row.expiration };
  });
}

export async function kvPut(siteDir: string, namespace: string, key: string, value: string, options: { expirationTtl?: number; metadata?: unknown }) {
  await write(siteDir, (db) => new KVNamespace(db, namespace).put(key, value, options));
}

export async function kvDelete(siteDir: string, namespace: string, key: string) {
  await write(siteDir, (db) => new KVNamespace(db, namespace).delete(key));
}

// ---------- R2 ----------

export function r2Buckets(siteDir: string, release: Release | undefined) {
  const bound = new Map((release?.manifest.r2Buckets ?? []).map((b) => [b.bucketName, b.binding]));
  type Bucket = { name: string; binding: string | null; count: number; countCapped?: boolean; size: number };
  return read<Bucket[]>(
    siteDir,
    [...bound].map(([name, binding]) => ({ name, binding, count: 0, size: 0 })),
    (db) => {
      const names = [...new Set([...bound.keys(), ...distinctNames(db, "r2", "bucket", R2_BUCKET_NAME)])];
      const stats = db.prepare(
        "SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN typeof(size) = 'integer' THEN size ELSE 0 END), 0) AS s FROM (SELECT size FROM r2 WHERE bucket = ? LIMIT ?)",
      );
      return names.map((name) => {
        const { n, s } = stats.get(name, COUNT_CAP + 1) as { n: number; s: number };
        return { name, binding: bound.get(name) ?? null, ...capped(n), size: s };
      });
    },
  ).sort((a, b) => (a.name < b.name ? -1 : 1));
}

function validateR2Key(key: string): string {
  if (key === "" || Buffer.byteLength(key) > MAX_R2_KEY) throw new TypeError(`R2 のキーは空でない ${MAX_R2_KEY} バイト以内の文字列にしてください`);
  return key;
}

/** メタデータは大きすぎれば読まない（子が直接書いた大きな値を JSON.parse しない） */
const R2_META = `CASE WHEN typeof(http_metadata) = 'text' AND octet_length(http_metadata) <= ${MAX_R2_METADATA} THEN http_metadata END AS http_metadata,
  CASE WHEN typeof(custom_metadata) = 'text' AND octet_length(custom_metadata) <= ${MAX_R2_METADATA} THEN custom_metadata END AS custom_metadata`;

interface R2Row {
  key: string;
  version: unknown;
  size: unknown;
  etag: unknown;
  uploaded: unknown;
  http_metadata: string | null;
  custom_metadata: string | null;
}

const R2_ROW = `SELECT key, CASE WHEN octet_length(version) <= 64 THEN version END AS version, size,
  CASE WHEN octet_length(etag) <= 64 THEN etag END AS etag, uploaded, ${R2_META} FROM r2`;

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** R2Bucket.list と同じく区切り（/）でまとめた一覧。行の形を確かめながら、ページの分だけを読む */
export function r2List(siteDir: string, bucket: string, prefix: string, cursor: string | undefined) {
  type Item = { key: string; size: number; uploaded: string; etag: string; contentType: string | null; customMetadata: Record<string, unknown> };
  return read(siteDir, { objects: [] as Item[], prefixes: [] as string[], cursor: null as string | null }, (db) => {
    const range = prefixRange("key", prefix);
    const list = db.prepare(
      `SELECT key FROM r2 WHERE bucket = ? AND key > ? AND ${range.sql} AND typeof(key) = 'text' AND octet_length(key) <= ${MAX_R2_KEY} ORDER BY key LIMIT ?`,
    );
    const get = db.prepare(`${R2_ROW} WHERE bucket = ? AND key = ?`);
    let after = cursor ? Buffer.from(cursor, "base64url").toString("utf8") : "";
    const objects: Item[] = [];
    const prefixes: string[] = [];
    let truncated = false;
    outer: while (true) {
      const rows = list.all(bucket, after, ...range.params, PAGE + 1) as { key: string }[];
      if (rows.length === 0) break;
      for (const { key } of rows) {
        if (objects.length + prefixes.length >= PAGE) {
          truncated = true;
          break outer;
        }
        const idx = key.indexOf("/", prefix.length);
        if (idx !== -1) {
          const p = key.slice(0, idx + 1);
          prefixes.push(p);
          after = `${p}\u{10FFFF}`;
          continue outer;
        }
        const row = get.get(bucket, key) as R2Row | undefined;
        if (!row) continue;
        const http = parseRecord(row.http_metadata);
        objects.push({
          key,
          size: num(row.size),
          uploaded: new Date(num(row.uploaded)).toISOString(),
          etag: typeof row.etag === "string" ? row.etag : "",
          contentType: typeof http.contentType === "string" ? http.contentType : null,
          customMetadata: parseRecord(row.custom_metadata),
        });
        after = key;
      }
    }
    return { objects, prefixes, cursor: truncated ? Buffer.from(after).toString("base64url") : null };
  });
}

/** オブジェクトのファイル名（R2Bucket が put で作る 16 バイトの 16 進数） */
const VERSION = /^[0-9a-f]{32}$/;

/**
 * オブジェクトのファイルを開く。DB の行（ファイル名・大きさ）は子が書き換えられるので、ファイル名の形を確かめ、
 * data/r2 とバケットのディレクトリがシンボリックリンクでないことも確かめる（R2Bucket と同じ）。大きさは開いたファイルの fstat を使う。
 * FIFO を開いてスレッドプールを止められないよう O_NONBLOCK で開き、普通のファイルでなければ使わない
 */
async function openObject(siteDir: string, bucket: string, key: string): Promise<{ handle: fsp.FileHandle; size: number } | null> {
  if (!R2_BUCKET_NAME.test(bucket)) throw new TypeError(`R2 のバケット名が不正です: ${bucket}`);
  validateR2Key(key);
  const version = read(siteDir, null, (db) => (db.prepare(`${R2_ROW} WHERE bucket = ? AND key = ?`).get(bucket, key) as R2Row | undefined)?.version);
  if (version === null || version === undefined) return null;
  if (typeof version !== "string" || !VERSION.test(version)) throw new SiteDataError("R2 のファイル名が不正です");
  const root = await fsp.realpath(siteDataDir(siteDir));
  const dir = path.join(root, "r2", bucket);
  if ((await fsp.realpath(dir).catch(() => null)) !== dir) return null;
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(path.join(dir, version), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const st = await handle.stat().catch(() => null);
  if (!st?.isFile()) {
    await handle.close();
    return st ? Promise.reject(new SiteDataError("R2 のファイルが普通のファイルではありません")) : null;
  }
  return { handle, size: st.size };
}

/** 先頭の PREVIEW_BYTES だけを読む */
export async function r2Preview(siteDir: string, bucket: string, key: string) {
  const obj = await openObject(siteDir, bucket, key);
  if (!obj) return null;
  try {
    const buf = Buffer.alloc(Math.min(obj.size, PREVIEW_BYTES));
    const { bytesRead } = await obj.handle.read(buf, 0, buf.length, 0);
    const truncated = obj.size > PREVIEW_BYTES;
    return { text: asText(buf.subarray(0, bytesRead), truncated), size: obj.size, truncated };
  } finally {
    await obj.handle.close();
  }
}

/** ダウンロード用に開く。stream は開いたときの大きさまでしか読まない（Content-Length と食い違わないように） */
export async function r2Download(siteDir: string, bucket: string, key: string) {
  const obj = await openObject(siteDir, bucket, key);
  if (!obj) return null;
  if (obj.size === 0) {
    await obj.handle.close();
    return { size: 0, stream: null };
  }
  return { size: obj.size, stream: obj.handle.createReadStream({ start: 0, end: obj.size - 1 }) };
}

/** 書き換える前の行のメタデータが大きすぎないか（R2Bucket は前の行を丸ごと読む） */
function checkR2Row(db: DatabaseSync, bucket: string, key: string): void {
  const bad = db
    .prepare(
      `SELECT 1 FROM r2 WHERE bucket = ? AND key = ? AND (octet_length(http_metadata) > ${MAX_R2_METADATA} OR octet_length(custom_metadata) > ${MAX_R2_METADATA}
         OR octet_length(version) > 64 OR octet_length(etag) > 64)`,
    )
    .get(bucket, key);
  if (bad) throw new SiteDataError("R2 のメタデータが大きすぎます");
}

export async function r2Put(siteDir: string, bucket: string, key: string, body: Buffer, contentType: string | undefined) {
  await write(siteDir, async (db) => {
    checkR2Row(db, bucket, validateR2Key(key));
    await new R2Bucket(db, siteDir, bucket).put(key, body, { httpMetadata: contentType ? { contentType } : undefined });
  });
}

export async function r2Delete(siteDir: string, bucket: string, key: string) {
  await write(siteDir, async (db) => {
    checkR2Row(db, bucket, validateR2Key(key));
    await new R2Bucket(db, siteDir, bucket).delete(key);
  });
}

export { PREVIEW_BYTES };
