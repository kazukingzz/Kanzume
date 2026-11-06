import { createHash, createHmac, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/** バックアップの保存先。キーは `/` 区切りの相対パス（プレフィックスは各実装が付ける） */
export interface BackupStore {
  put(key: string, body: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  list(prefix: string): Promise<string[]>;
  delete(key: string): Promise<void>;
}

export class BackupStoreError extends Error {}

/** 開発・テスト用。ディレクトリにそのまま置く */
export class LocalStore implements BackupStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = path.resolve(dir);
  }

  #path(key: string): string {
    const p = path.join(this.dir, ...key.split("/"));
    if (!p.startsWith(this.dir + path.sep)) throw new BackupStoreError("キーが不正です");
    return p;
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    const p = this.#path(key);
    await fs.mkdir(path.dirname(p), { recursive: true });
    const tmp = `${p}.${randomBytes(6).toString("hex")}.tmp`;
    await fs.writeFile(tmp, body);
    await fs.rename(tmp, p);
  }

  async get(key: string): Promise<Uint8Array | null> {
    return fs.readFile(this.#path(key)).catch((err) => {
      if (err.code === "ENOENT") return null;
      throw err;
    });
  }

  async list(prefix: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (rel: string) => {
      const entries = await fs.readdir(path.join(this.dir, rel), { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        const key = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(key);
        else if (e.isFile() && !e.name.endsWith(".tmp") && key.startsWith(prefix)) out.push(key);
      }
    };
    // プレフィックスのディレクトリ部分から歩く
    await walk(prefix.includes("/") ? prefix.slice(0, prefix.lastIndexOf("/")) : "");
    return out.sort();
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.#path(key), { force: true });
  }
}

// ---------- S3 互換 API（SigV4） ----------

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();

/** RFC 3986 の非予約文字以外をエンコードする（SigV4 の UriEncode） */
export function uriEncode(s: string, encodeSlash = true): string {
  let out = "";
  for (const byte of Buffer.from(s, "utf8")) {
    const c = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-_.~]/.test(c) || (c === "/" && !encodeSlash)) out += c;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

export interface SignInput {
  method: string;
  /** エンコード済みのパス（/bucket/key） */
  path: string;
  query: Record<string, string>;
  /** 署名するヘッダー（host を含む）。名前は小文字 */
  headers: Record<string, string>;
  payloadHash: string;
  accessKeyId: string;
  secret: string;
  region: string;
  /** 20130524T000000Z */
  amzDate: string;
}

/** AWS Signature Version 4 の Authorization ヘッダー */
export function signV4(input: SignInput): string {
  const query = Object.keys(input.query)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(input.query[k])}`)
    .join("&");
  const names = Object.keys(input.headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${input.headers[n].trim()}\n`).join("");
  const signedHeaders = names.join(";");
  const canonical = [input.method, input.path, query, canonicalHeaders, signedHeaders, input.payloadHash].join("\n");
  const day = input.amzDate.slice(0, 8);
  const scope = `${day}/${input.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", input.amzDate, scope, sha256(canonical)].join("\n");
  let key = hmac(`AWS4${input.secret}`, day);
  key = hmac(key, input.region);
  key = hmac(key, "s3");
  key = hmac(key, "aws4_request");
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  return `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

const decodeXml = (s: string) =>
  s.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-f]+);/gi, (_, e: string) => {
    const named: Record<string, string> = { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" };
    if (named[e.toLowerCase()]) return named[e.toLowerCase()];
    return String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  });

/** 1 回のリクエストの時間制限。PUT は 60 秒 + 256 KiB/秒で送れる時間、GET は大きさが分からないので 10 分 */
export function timeoutFor(method: string, bytes: number): number {
  if (method === "GET") return 10 * 60_000;
  return 60_000 + Math.ceil(bytes / (256 * 1024)) * 1000;
}

export interface S3Options {
  /** https://<account>.r2.cloudflarestorage.com */
  endpoint: string;
  bucket: string;
  /** 末尾の / なし。空ならバケットのトップ */
  prefix: string;
  accessKeyId: string;
  secret: string;
  region: string;
  fetch?: typeof fetch;
}

/** S3 互換 API（R2・AWS S3・B2・MinIO）。パス形式（https://endpoint/bucket/key）でアクセスする */
export class S3Store implements BackupStore {
  #o: S3Options;
  #fetch: typeof fetch;

  constructor(options: S3Options) {
    this.#o = { ...options, endpoint: options.endpoint.replace(/\/+$/, "") };
    this.#fetch = options.fetch ?? fetch;
  }

  #key(key: string): string {
    return this.#o.prefix ? `${this.#o.prefix}/${key}` : key;
  }

  /** 認証情報が混ざらないように、メッセージから鍵を消す */
  #scrub(s: string): string {
    let out = s;
    for (const secret of [this.#o.secret, this.#o.accessKeyId]) if (secret) out = out.split(secret).join("***");
    return out;
  }

  async #request(method: string, key: string | null, query: Record<string, string> = {}, body?: Uint8Array): Promise<Response> {
    const url = new URL(this.#o.endpoint);
    const p = `${url.pathname.replace(/\/+$/, "")}/${uriEncode(this.#o.bucket)}${key !== null ? `/${uriEncode(key, false)}` : ""}`;
    const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
    const payloadHash = sha256(body ?? new Uint8Array());
    const headers: Record<string, string> = { host: url.host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
    const authorization = signV4({ method, path: p, query, headers, payloadHash, accessKeyId: this.#o.accessKeyId, secret: this.#o.secret, region: this.#o.region, amzDate });
    const qs = Object.keys(query)
      .sort()
      .map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`)
      .join("&");
    const { host: _host, ...sent } = headers;
    let res: Response;
    try {
      res = await this.#fetch(`${url.origin}${p}${qs ? `?${qs}` : ""}`, {
        method,
        headers: { ...sent, authorization },
        body: body as BodyInit | undefined,
        // 時間制限は本文の転送にもかかるので、大きさに合わせて延ばす（遅い回線でも大きなファイルを送れるように）
        signal: AbortSignal.timeout(timeoutFor(method, body?.byteLength ?? 0)),
      });
    } catch (err) {
      throw new BackupStoreError(this.#scrub(`保存先に接続できません（${method}）: ${(err as Error)?.message ?? err}`));
    }
    return res;
  }

  async #fail(res: Response, what: string): Promise<never> {
    const text = await res.text().catch(() => "");
    const code = /<Code>([^<]*)<\/Code>/.exec(text)?.[1];
    const message = /<Message>([^<]*)<\/Message>/.exec(text)?.[1];
    // AccessKeyId などを含む要素は出さず、Code と Message だけを残す
    throw new BackupStoreError(this.#scrub(`保存先の ${what} に失敗しました（HTTP ${res.status}${code ? ` ${decodeXml(code)}` : ""}${message ? `: ${decodeXml(message)}` : ""}）`));
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    const res = await this.#request("PUT", this.#key(key), {}, body);
    if (!res.ok) return this.#fail(res, "書き込み");
    await res.arrayBuffer().catch(() => {});
  }

  async get(key: string): Promise<Uint8Array | null> {
    const res = await this.#request("GET", this.#key(key));
    if (res.status === 404) {
      await res.arrayBuffer().catch(() => {});
      return null;
    }
    if (!res.ok) return this.#fail(res, "読み込み");
    return new Uint8Array(await res.arrayBuffer());
  }

  async list(prefix: string): Promise<string[]> {
    const out: string[] = [];
    const strip = this.#o.prefix ? this.#o.prefix.length + 1 : 0;
    let token: string | undefined;
    do {
      const query: Record<string, string> = { "list-type": "2", prefix: this.#key(prefix) };
      if (token) query["continuation-token"] = token;
      const res = await this.#request("GET", null, query);
      if (!res.ok) return this.#fail(res, "一覧の取得");
      const xml = await res.text();
      for (const m of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) out.push(decodeXml(m[1]).slice(strip));
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? decodeXml(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1] ?? "") || undefined : undefined;
    } while (token);
    return out.sort();
  }

  async delete(key: string): Promise<void> {
    const res = await this.#request("DELETE", this.#key(key));
    if (!res.ok && res.status !== 404) return this.#fail(res, "削除");
    await res.arrayBuffer().catch(() => {});
  }
}
