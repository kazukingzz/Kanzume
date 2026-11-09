import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { siteDataDir, siteDb } from "../bindings/db.ts";
import { KVNamespace } from "../bindings/kv.ts";
import { R2Bucket } from "../bindings/r2.ts";
import type { Release } from "../store.ts";

/**
 * 管理画面の「データベース」（KV）と「ストレージ」（R2）タブ用の読み書き。
 * 書き込みは Worker と同じ KVNamespace / R2Bucket を通す（R2 のファイルとメタデータの整合を保つため）
 */

const PAGE = 100;
const PREVIEW_BYTES = 256 * 1024;
const now = () => Math.floor(Date.now() / 1000);

/** まだ一度も KV / R2 を使っていないサイトでは data.sqlite を作らない */
function openDb(siteDir: string): DatabaseSync | null {
  return fs.existsSync(path.join(siteDataDir(siteDir), "data.sqlite")) ? siteDb(siteDir) : null;
}

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

const parseJson = (s: string | null) => {
  if (s === null) return null;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

// ---------- KV ----------

/** wrangler の設定にある KV と、データだけが残っている KV（設定から外したもの）の一覧 */
export function kvNamespaces(siteDir: string, release: Release | undefined) {
  const bound = release?.manifest.kvNamespaces.map((k) => k.binding) ?? [];
  const db = openDb(siteDir);
  const counts = new Map<string, number>();
  if (db) {
    for (const row of db.prepare("SELECT namespace, COUNT(*) AS n FROM kv WHERE expiration IS NULL OR expiration > ? GROUP BY namespace").all(now()) as { namespace: string; n: number }[]) {
      counts.set(row.namespace, row.n);
    }
  }
  const names = [...new Set([...bound, ...counts.keys()])].sort();
  return names.map((name) => ({ name, bound: bound.includes(name), count: counts.get(name) ?? 0 }));
}

export function kvKeys(siteDir: string, namespace: string, prefix: string, after: string) {
  const db = openDb(siteDir);
  if (!db) return { keys: [], cursor: null };
  const rows = db
    .prepare(
      "SELECT key, length(value) AS size, metadata, expiration FROM kv WHERE namespace = ? AND key > ? AND instr(key, ?) = 1 AND (expiration IS NULL OR expiration > ?) ORDER BY key LIMIT ?",
    )
    .all(namespace, after, prefix, now(), PAGE + 1) as { key: string; size: number; metadata: string | null; expiration: number | null }[];
  const page = rows.slice(0, PAGE);
  return {
    keys: page.map((r) => ({ key: r.key, size: r.size, metadata: parseJson(r.metadata), expiration: r.expiration })),
    cursor: rows.length > PAGE ? page.at(-1)!.key : null,
  };
}

export function kvValue(siteDir: string, namespace: string, key: string) {
  const db = openDb(siteDir);
  const row = db?.prepare("SELECT value, metadata, expiration FROM kv WHERE namespace = ? AND key = ? AND (expiration IS NULL OR expiration > ?)").get(namespace, key, now()) as
    | { value: Uint8Array; metadata: string | null; expiration: number | null }
    | undefined;
  if (!row) return null;
  const head = row.value.subarray(0, PREVIEW_BYTES);
  return {
    key,
    size: row.value.byteLength,
    text: asText(head, row.value.byteLength > PREVIEW_BYTES),
    truncated: row.value.byteLength > PREVIEW_BYTES,
    metadata: parseJson(row.metadata),
    expiration: row.expiration,
  };
}

export async function kvPut(siteDir: string, namespace: string, key: string, value: string, options: { expirationTtl?: number; metadata?: unknown }) {
  await new KVNamespace(siteDb(siteDir), namespace).put(key, value, options);
}

export async function kvDelete(siteDir: string, namespace: string, key: string) {
  await new KVNamespace(siteDb(siteDir), namespace).delete(key);
}

// ---------- R2 ----------

export function r2Buckets(siteDir: string, release: Release | undefined) {
  const bound = new Map((release?.manifest.r2Buckets ?? []).map((b) => [b.bucketName, b.binding]));
  const db = openDb(siteDir);
  const stats = new Map<string, { count: number; size: number }>();
  if (db) {
    for (const row of db.prepare("SELECT bucket, COUNT(*) AS n, COALESCE(SUM(size), 0) AS s FROM r2 GROUP BY bucket").all() as { bucket: string; n: number; s: number }[]) {
      stats.set(row.bucket, { count: row.n, size: row.s });
    }
  }
  const names = [...new Set([...bound.keys(), ...stats.keys()])].sort();
  return names.map((name) => ({ name, binding: bound.get(name) ?? null, ...(stats.get(name) ?? { count: 0, size: 0 }) }));
}

export async function r2List(siteDir: string, bucket: string, prefix: string, cursor: string | undefined) {
  if (!openDb(siteDir)) return { objects: [], prefixes: [], cursor: null };
  const result = (await new R2Bucket(siteDb(siteDir), siteDir, bucket).list({ prefix, delimiter: "/", limit: PAGE, cursor, include: ["httpMetadata", "customMetadata"] })) as {
    objects: { key: string; size: number; uploaded: Date; etag: string; httpMetadata: { contentType?: string }; customMetadata: Record<string, string> }[];
    delimitedPrefixes: string[];
    truncated: boolean;
    cursor?: string;
  };
  return {
    objects: result.objects.map((o) => ({
      key: o.key,
      size: o.size,
      uploaded: o.uploaded.toISOString(),
      etag: o.etag,
      contentType: o.httpMetadata.contentType ?? null,
      customMetadata: o.customMetadata,
    })),
    prefixes: result.delimitedPrefixes,
    cursor: result.truncated ? (result.cursor ?? null) : null,
  };
}

export function r2Bucket(siteDir: string, bucket: string) {
  return new R2Bucket(siteDb(siteDir), siteDir, bucket);
}

export { PREVIEW_BYTES };
