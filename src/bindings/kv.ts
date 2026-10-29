import type { DatabaseSync, StatementSync } from "node:sqlite";
import { toArrayBuffer, toBytes, toStream } from "./bytes.ts";

type ValueType = "text" | "json" | "arrayBuffer" | "stream";
type GetOptions = ValueType | { type?: ValueType; cacheTtl?: number } | undefined;

interface PutOptions {
  expiration?: number;
  expirationTtl?: number;
  metadata?: unknown;
}

interface ListOptions {
  prefix?: string | null;
  limit?: number;
  cursor?: string | null;
}

interface Row {
  value: Uint8Array;
  metadata: string | null;
}

const MAX_KEY_BYTES = 512;
const MAX_VALUE_BYTES = 25 * 1024 * 1024;
const MAX_METADATA_BYTES = 1024;
const MIN_TTL = 60;

const now = () => Math.floor(Date.now() / 1000);

function validateKey(key: unknown): string {
  if (typeof key !== "string" || key === "") throw new TypeError("KV のキーは空でない文字列にしてください");
  if (key === "." || key === "..") throw new TypeError(`KV のキーに "${key}" は使えません`);
  if (Buffer.byteLength(key) > MAX_KEY_BYTES) throw new TypeError(`KV のキーは ${MAX_KEY_BYTES} バイト以内にしてください`);
  return key;
}

function decode(row: Row, type: ValueType): unknown {
  switch (type) {
    case "text":
      return Buffer.from(row.value).toString("utf8");
    case "json":
      return JSON.parse(Buffer.from(row.value).toString("utf8"));
    case "arrayBuffer":
      return toArrayBuffer(row.value);
    case "stream":
      return toStream(row.value);
    default:
      throw new TypeError(`未対応の type です: ${type}`);
  }
}

function typeOf(options: GetOptions): ValueType {
  return (typeof options === "string" ? options : options?.type) ?? "text";
}

export class KVNamespace {
  #get: StatementSync;
  #put: StatementSync;
  #delete: StatementSync;
  #list: StatementSync;
  #namespace: string;

  constructor(db: DatabaseSync, namespace: string) {
    this.#namespace = namespace;
    this.#get = db.prepare("SELECT value, metadata FROM kv WHERE namespace = ? AND key = ? AND (expiration IS NULL OR expiration > ?)");
    this.#put = db.prepare("INSERT OR REPLACE INTO kv (namespace, key, value, metadata, expiration) VALUES (?, ?, ?, ?, ?)");
    this.#delete = db.prepare("DELETE FROM kv WHERE namespace = ? AND key = ?");
    this.#list = db.prepare(
      "SELECT key, metadata, expiration FROM kv WHERE namespace = ? AND key > ? AND instr(key, ?) = 1 AND (expiration IS NULL OR expiration > ?) ORDER BY key LIMIT ?",
    );
  }

  #row(key: string): Row | undefined {
    return this.#get.get(this.#namespace, validateKey(key), now()) as Row | undefined;
  }

  async get(key: string | string[], options?: GetOptions): Promise<unknown> {
    const type = typeOf(options);
    if (Array.isArray(key)) {
      if (type !== "text" && type !== "json") throw new TypeError("複数キーの get は text か json のみ対応しています");
      return new Map(key.map((k) => {
        const row = this.#row(k);
        return [k, row ? decode(row, type) : null];
      }));
    }
    const row = this.#row(key);
    return row ? decode(row, type) : null;
  }

  async getWithMetadata(key: string | string[], options?: GetOptions): Promise<unknown> {
    const type = typeOf(options);
    const one = (k: string) => {
      const row = this.#row(k);
      return row
        ? { value: decode(row, type), metadata: row.metadata === null ? null : JSON.parse(row.metadata), cacheStatus: null }
        : { value: null, metadata: null, cacheStatus: null };
    };
    if (Array.isArray(key)) return new Map(key.map((k) => [k, one(k)]));
    return one(key);
  }

  async put(key: string, value: unknown, options: PutOptions = {}): Promise<void> {
    validateKey(key);
    const bytes = await toBytes(value);
    if (bytes.byteLength > MAX_VALUE_BYTES) throw new TypeError("KV の値は 25 MiB 以内にしてください");

    let expiration: number | null = null;
    if (options.expirationTtl !== undefined) {
      if (!(options.expirationTtl >= MIN_TTL)) throw new TypeError(`expirationTtl は ${MIN_TTL} 秒以上にしてください`);
      expiration = now() + Math.floor(options.expirationTtl);
    } else if (options.expiration !== undefined) {
      if (!(options.expiration >= now() + MIN_TTL)) throw new TypeError(`expiration は ${MIN_TTL} 秒以上先にしてください`);
      expiration = Math.floor(options.expiration);
    }

    let metadata: string | null = null;
    if (options.metadata !== undefined && options.metadata !== null) {
      metadata = JSON.stringify(options.metadata);
      if (Buffer.byteLength(metadata) > MAX_METADATA_BYTES) throw new TypeError("metadata は 1024 バイト以内にしてください");
    }

    this.#put.run(this.#namespace, key, bytes, metadata, expiration);
  }

  async delete(key: string): Promise<void> {
    this.#delete.run(this.#namespace, validateKey(key));
  }

  async list(options: ListOptions = {}): Promise<unknown> {
    const prefix = options.prefix ?? "";
    const limit = Math.min(Math.max(Math.floor(options.limit ?? 1000), 1), 1000);
    const after = options.cursor ? Buffer.from(options.cursor, "base64url").toString("utf8") : "";
    const rows = this.#list.all(this.#namespace, after, prefix, now(), limit + 1) as {
      key: string;
      metadata: string | null;
      expiration: number | null;
    }[];
    const complete = rows.length <= limit;
    const keys = rows.slice(0, limit).map((r) => ({
      name: r.key,
      ...(r.expiration !== null && { expiration: r.expiration }),
      ...(r.metadata !== null && { metadata: JSON.parse(r.metadata) }),
    }));
    return complete
      ? { keys, list_complete: true, cacheStatus: null }
      : { keys, list_complete: false, cursor: Buffer.from(keys[keys.length - 1].name).toString("base64url"), cacheStatus: null };
  }
}
