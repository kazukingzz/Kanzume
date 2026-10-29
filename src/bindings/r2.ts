import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { Readable } from "node:stream";
import { toBytes } from "./bytes.ts";

interface HttpMetadata {
  contentType?: string;
  contentLanguage?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  cacheControl?: string;
  cacheExpiry?: Date;
}

interface Conditional {
  etagMatches?: string;
  etagDoesNotMatch?: string;
  uploadedBefore?: Date;
  uploadedAfter?: Date;
}

interface Range {
  offset?: number;
  length?: number;
  suffix?: number;
}

interface Row {
  key: string;
  version: string;
  size: number;
  etag: string;
  uploaded: number;
  http_metadata: string;
  custom_metadata: string;
}

const MAX_KEY_BYTES = 1024;

const HTTP_HEADERS: [keyof HttpMetadata, string][] = [
  ["contentType", "content-type"],
  ["contentLanguage", "content-language"],
  ["contentDisposition", "content-disposition"],
  ["contentEncoding", "content-encoding"],
  ["cacheControl", "cache-control"],
];

function isHeaders(value: unknown): value is Headers {
  return !!value && typeof (value as Headers).get === "function" && typeof (value as Headers).entries === "function";
}

function validateKey(key: unknown): string {
  if (typeof key !== "string" || key === "") throw new TypeError("R2 のキーは空でない文字列にしてください");
  if (Buffer.byteLength(key) > MAX_KEY_BYTES) throw new TypeError(`R2 のキーは ${MAX_KEY_BYTES} バイト以内にしてください`);
  return key;
}

function normalizeHttpMetadata(input: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input) return out;
  if (isHeaders(input)) {
    for (const [field, header] of HTTP_HEADERS) {
      const v = input.get(header);
      if (v !== null) out[field] = v;
    }
    const expires = input.get("expires");
    if (expires) out.cacheExpiry = new Date(expires).toISOString();
    return out;
  }
  const m = input as HttpMetadata;
  for (const [field] of HTTP_HEADERS) {
    if (typeof m[field] === "string") out[field] = m[field] as string;
  }
  if (m.cacheExpiry) out.cacheExpiry = new Date(m.cacheExpiry).toISOString();
  return out;
}

function stripEtag(etag: string): string {
  return etag.trim().replace(/^W\//, "").replace(/^"(.*)"$/, "$1");
}

function etagMatches(condition: string, etag: string): boolean {
  return condition.split(",").some((c) => c.trim() === "*" || stripEtag(c) === etag);
}

function normalizeConditional(input: unknown): Conditional | undefined {
  if (!input) return undefined;
  if (!isHeaders(input)) return input as Conditional;
  const c: Conditional = {};
  const ifMatch = input.get("if-match");
  const ifNoneMatch = input.get("if-none-match");
  const ifModifiedSince = input.get("if-modified-since");
  const ifUnmodifiedSince = input.get("if-unmodified-since");
  if (ifMatch) c.etagMatches = ifMatch;
  if (ifNoneMatch) c.etagDoesNotMatch = ifNoneMatch;
  if (ifModifiedSince) c.uploadedAfter = new Date(ifModifiedSince);
  if (ifUnmodifiedSince) c.uploadedBefore = new Date(ifUnmodifiedSince);
  return c;
}

function passes(cond: Conditional | undefined, row: Row): boolean {
  if (!cond) return true;
  const uploaded = Math.floor(row.uploaded / 1000) * 1000;
  if (cond.etagMatches !== undefined && !etagMatches(cond.etagMatches, row.etag)) return false;
  if (cond.etagDoesNotMatch !== undefined && etagMatches(cond.etagDoesNotMatch, row.etag)) return false;
  if (cond.uploadedBefore !== undefined && !(uploaded < new Date(cond.uploadedBefore).getTime())) return false;
  if (cond.uploadedAfter !== undefined && !(uploaded > new Date(cond.uploadedAfter).getTime())) return false;
  return true;
}

function resolveRange(input: unknown, size: number): { offset: number; length: number } | undefined {
  if (!input) return undefined;
  let range: Range;
  if (isHeaders(input)) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(input.get("range") ?? "");
    if (!m) return undefined;
    if (m[1] === "") range = { suffix: Number(m[2]) };
    else range = { offset: Number(m[1]), ...(m[2] !== "" && { length: Number(m[2]) - Number(m[1]) + 1 }) };
  } else {
    range = input as Range;
  }
  if (range.suffix !== undefined) {
    const length = Math.min(range.suffix, size);
    return { offset: size - length, length };
  }
  const offset = Math.min(range.offset ?? 0, size);
  return { offset, length: Math.min(range.length ?? size - offset, size - offset) };
}

export class R2Object {
  key: string;
  version: string;
  size: number;
  etag: string;
  httpEtag: string;
  uploaded: Date;
  httpMetadata: HttpMetadata;
  customMetadata: Record<string, string>;
  checksums: { md5: ArrayBuffer; toJSON(): { md5: string } };
  storageClass = "Standard";
  range?: { offset: number; length: number };

  constructor(row: Row, range?: { offset: number; length: number }) {
    this.key = row.key;
    this.version = row.version;
    this.size = row.size;
    this.etag = row.etag;
    this.httpEtag = `"${row.etag}"`;
    this.uploaded = new Date(row.uploaded);
    const http = JSON.parse(row.http_metadata);
    this.httpMetadata = { ...http, ...(http.cacheExpiry && { cacheExpiry: new Date(http.cacheExpiry) }) };
    this.customMetadata = JSON.parse(row.custom_metadata);
    const md5 = Buffer.from(row.etag, "hex");
    this.checksums = { md5: md5.buffer.slice(md5.byteOffset, md5.byteOffset + md5.byteLength) as ArrayBuffer, toJSON: () => ({ md5: row.etag }) };
    if (range) this.range = range;
  }

  writeHttpMetadata(headers: Headers): void {
    for (const [field, header] of HTTP_HEADERS) {
      const v = this.httpMetadata[field];
      if (typeof v === "string") headers.set(header, v);
    }
    if (this.httpMetadata.cacheExpiry) headers.set("expires", this.httpMetadata.cacheExpiry.toUTCString());
  }
}

export class R2ObjectBody extends R2Object {
  #response: Response;

  constructor(row: Row, body: ReadableStream<Uint8Array>, range?: { offset: number; length: number }) {
    super(row, range);
    this.#response = new Response(body);
  }

  get body(): ReadableStream<Uint8Array> {
    return this.#response.body!;
  }

  get bodyUsed(): boolean {
    return this.#response.bodyUsed;
  }

  arrayBuffer(): Promise<ArrayBuffer> {
    return this.#response.arrayBuffer();
  }

  bytes(): Promise<Uint8Array> {
    return this.#response.bytes();
  }

  text(): Promise<string> {
    return this.#response.text();
  }

  json(): Promise<unknown> {
    return this.#response.json();
  }

  blob(): Promise<Blob> {
    return this.#response.blob();
  }
}

export class R2Bucket {
  #dir: string;
  #bucket: string;
  #get: StatementSync;
  #upsert: StatementSync;
  #delete: StatementSync;
  #list: StatementSync;

  constructor(db: DatabaseSync, siteDir: string, bucket: string) {
    this.#bucket = bucket;
    this.#dir = path.join(siteDir, "r2", bucket);
    this.#get = db.prepare("SELECT * FROM r2 WHERE bucket = ? AND key = ?");
    this.#upsert = db.prepare(
      "INSERT OR REPLACE INTO r2 (bucket, key, version, size, etag, uploaded, http_metadata, custom_metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    this.#delete = db.prepare("DELETE FROM r2 WHERE bucket = ? AND key = ?");
    this.#list = db.prepare("SELECT * FROM r2 WHERE bucket = ? AND key > ? AND instr(key, ?) = 1 ORDER BY key LIMIT ?");
  }

  #row(key: string): Row | undefined {
    return this.#get.get(this.#bucket, validateKey(key)) as Row | undefined;
  }

  #file(version: string): string {
    return path.join(this.#dir, version);
  }

  async head(key: string): Promise<R2Object | null> {
    const row = this.#row(key);
    return row ? new R2Object(row) : null;
  }

  async get(key: string, options: { onlyIf?: unknown; range?: unknown } = {}): Promise<R2Object | R2ObjectBody | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const row = this.#row(key);
      if (!row) return null;
      if (!passes(normalizeConditional(options.onlyIf), row)) return new R2Object(row);
      const range = resolveRange(options.range, row.size);
      let handle: fs.FileHandle;
      try {
        handle = await fs.open(this.#file(row.version), "r");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw err;
      }
      const length = range ? range.length : row.size;
      if (length === 0) {
        await handle.close();
        return new R2ObjectBody(row, new ReadableStream({ start: (c) => c.close() }), range);
      }
      const stream = handle.createReadStream(range ? { start: range.offset, end: range.offset + length - 1 } : {});
      return new R2ObjectBody(row, Readable.toWeb(stream) as ReadableStream<Uint8Array>, range);
    }
    return null;
  }

  async put(
    key: string,
    value: unknown,
    options: { httpMetadata?: unknown; customMetadata?: Record<string, string>; onlyIf?: unknown; md5?: ArrayBuffer | string } = {},
  ): Promise<R2Object | null> {
    validateKey(key);
    const current = this.#row(key);
    const cond = normalizeConditional(options.onlyIf);
    if (cond && current && !passes(cond, current)) return null;
    if (cond?.etagMatches !== undefined && !current) return null;

    const data = await toBytes(value);
    const etag = createHash("md5").update(data).digest("hex");
    if (options.md5 !== undefined) {
      const expected = typeof options.md5 === "string" ? options.md5 : Buffer.from(options.md5 as ArrayBuffer).toString("hex");
      if (expected.toLowerCase() !== etag) throw new Error("put: md5 が一致しません");
    }

    const version = randomBytes(16).toString("hex");
    await fs.mkdir(this.#dir, { recursive: true });
    const tmp = `${this.#file(version)}.tmp`;
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, this.#file(version));

    const customMetadata: Record<string, string> = {};
    for (const [k, v] of Object.entries(options.customMetadata ?? {})) customMetadata[k] = String(v);
    const row: Row = {
      key,
      version,
      size: data.byteLength,
      etag,
      uploaded: Date.now(),
      http_metadata: JSON.stringify(normalizeHttpMetadata(options.httpMetadata)),
      custom_metadata: JSON.stringify(customMetadata),
    };
    this.#upsert.run(this.#bucket, key, version, row.size, etag, row.uploaded, row.http_metadata, row.custom_metadata);
    if (current) await fs.rm(this.#file(current.version), { force: true });
    return new R2Object(row);
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      const row = this.#row(key);
      if (!row) continue;
      this.#delete.run(this.#bucket, key);
      await fs.rm(this.#file(row.version), { force: true });
    }
  }

  async list(
    options: { prefix?: string; limit?: number; cursor?: string; startAfter?: string; delimiter?: string; include?: string[] } = {},
  ): Promise<unknown> {
    const prefix = options.prefix ?? "";
    const limit = Math.min(Math.max(Math.floor(options.limit ?? 1000), 1), 1000);
    const delimiter = options.delimiter ?? "";
    const include = new Set(options.include ?? []);
    let after = options.cursor ? Buffer.from(options.cursor, "base64url").toString("utf8") : (options.startAfter ?? "");

    const objects: R2Object[] = [];
    const delimitedPrefixes: string[] = [];
    let truncated = false;

    outer: while (true) {
      const rows = this.#list.all(this.#bucket, after, prefix, 1000) as unknown as Row[];
      if (rows.length === 0) break;
      for (const row of rows) {
        if (objects.length + delimitedPrefixes.length >= limit) {
          truncated = true;
          break outer;
        }
        const rest = row.key.slice(prefix.length);
        const idx = delimiter ? rest.indexOf(delimiter) : -1;
        if (idx !== -1) {
          const p = prefix + rest.slice(0, idx + delimiter.length);
          delimitedPrefixes.push(p);
          after = `${p}\u{10FFFF}`;
          continue outer;
        }
        const object = new R2Object(row);
        if (!include.has("httpMetadata")) object.httpMetadata = {};
        if (!include.has("customMetadata")) object.customMetadata = {};
        objects.push(object);
        after = row.key;
      }
    }

    return truncated
      ? { objects, delimitedPrefixes, truncated: true, cursor: Buffer.from(after).toString("base64url") }
      : { objects, delimitedPrefixes, truncated: false };
  }

  createMultipartUpload(): never {
    throw new Error("Kanzume の R2 はマルチパートアップロードに対応していません");
  }

  resumeMultipartUpload(): never {
    throw new Error("Kanzume の R2 はマルチパートアップロードに対応していません");
  }
}
