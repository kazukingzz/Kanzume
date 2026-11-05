import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";
import type { BackupStore } from "./store.ts";

const MAGIC = Buffer.from("KZB1");
const SALT = "kanzume-backup";

export class KeyMismatchError extends Error {}

export interface Kek {
  id: string;
  key: Buffer;
}

/** SECRET_ACCESS_KEY から鍵を包む鍵（KEK）と、その ID を導出する */
export function deriveKek(secret: string): Kek {
  const key = Buffer.from(hkdfSync("sha256", secret, SALT, "kek v1", 32));
  const id = Buffer.from(hkdfSync("sha256", secret, SALT, "kek-id v1", 8)).toString("hex");
  return { id, key };
}

/** AES-256-GCM。形式は `KZB1 | nonce(12) | ciphertext | tag(16)` */
export function encrypt(key: Buffer, plain: Uint8Array, aad: string): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, nonce, body, cipher.getAuthTag()]);
}

export function decrypt(key: Buffer, data: Uint8Array, aad: string): Buffer {
  const buf = Buffer.from(data);
  if (buf.length < 32 || !buf.subarray(0, 4).equals(MAGIC)) throw new Error("バックアップの形式が正しくありません");
  const decipher = createDecipheriv("aes-256-gcm", key, buf.subarray(4, 16));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(buf.subarray(buf.length - 16));
  return Buffer.concat([decipher.update(buf.subarray(16, buf.length - 16)), decipher.final()]);
}

/** データを暗号化する鍵（DEK）。ブロブの名前は中身の HMAC にする（同じ中身は 1 回だけ送る） */
export class Dek {
  readonly id: string;
  readonly key: Buffer;
  #mac: Buffer;

  constructor(key: Buffer) {
    this.key = key;
    this.id = createHash("sha256").update(key).digest("hex").slice(0, 16);
    this.#mac = Buffer.from(hkdfSync("sha256", key, SALT, "blob-name v1", 32));
  }

  blobName(plain: Uint8Array): string {
    return createHmac("sha256", this.#mac).update(plain).digest("hex");
  }
}

const KEY_AAD = "kanzume-dek";

/**
 * DEK を用意する（エンベロープ暗号）。
 * 1. 今の SECRET から導出した KEK で `keys/<kekId>` を開けたらそれを使う
 * 2. なければ previous（旧 SECRET）の KEK で開き、今の KEK で包み直して `keys/<kekId>` に書く
 * 3. `keys/` が空なら、新しい DEK を作る
 * 4. どれでもなければ KeyMismatchError（新しい DEK は作らない。旧い世代を読めなくしないため）
 */
export async function loadDek(store: BackupStore, secret: string, previous?: string): Promise<Dek> {
  const kek = deriveKek(secret);
  const open = (k: Kek, data: Uint8Array) => {
    try {
      return new Dek(decrypt(k.key, data, KEY_AAD));
    } catch {
      throw new KeyMismatchError(`バックアップの鍵（${k.id}）を開けません`);
    }
  };
  const current = await store.get(`keys/${kek.id}`);
  if (current) return open(kek, current);
  if (previous) {
    const old = deriveKek(previous);
    const data = await store.get(`keys/${old.id}`);
    if (data) {
      const dek = open(old, data);
      await store.put(`keys/${kek.id}`, encrypt(kek.key, dek.key, KEY_AAD));
      console.log(`[backup] 鍵を入れ替えました（${old.id} → ${kek.id}）。URL の previous はもう外して構いません`);
      return dek;
    }
  }
  const existing = await store.list("keys/");
  if (existing.length) {
    throw new KeyMismatchError(
      `今の鍵（${kek.id}）ではバックアップを開けません（保存されている鍵: ${existing.map((k) => k.slice(5)).join(", ")}）。SECRET を替えたときは、URL に ?previous=<旧 SECRET（パーセントエンコード）> を付けて起動してください`,
    );
  }
  const dek = new Dek(randomBytes(32));
  await store.put(`keys/${kek.id}`, encrypt(kek.key, dek.key, KEY_AAD));
  return dek;
}
