export class BackupUrlError extends Error {}

interface Common {
  /** 残す世代の数 */
  keep: number;
  intervalMs: number;
  /** 認証情報を含まない保存先の説明（ログ・管理画面用） */
  target: string;
}

export type BackupConfig =
  | (Common & {
      kind: "s3";
      endpoint: string;
      bucket: string;
      prefix: string;
      accessKeyId: string;
      secret: string;
      region: string;
      /** 鍵を替えるときだけ付ける旧い SECRET_ACCESS_KEY */
      previous?: string;
    })
  | (Common & {
      kind: "file";
      dir: string;
      /** file:// には SECRET がないので、暗号化の鍵は ?secret= で渡す（なければ固定の開発用の値） */
      secret: string;
      previous?: string;
    });

const DEFAULT_KEEP = 48;
const DEFAULT_INTERVAL_MIN = 60;
const DEV_SECRET = "kanzume-local-backup";

function decode(s: string, what: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    throw new BackupUrlError(`KANZUME_BACKUP_URL の${what}のパーセントエンコードが正しくありません`);
  }
}

function intParam(params: URLSearchParams, name: string, def: number, min: number, max: number): number {
  const raw = params.get(name);
  if (raw === null || raw === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new BackupUrlError(`KANZUME_BACKUP_URL の ${name} は ${min}〜${max} の整数にしてください`);
  return n;
}

/**
 * KANZUME_BACKUP_URL を読む。未設定なら null（バックアップしない）。
 * - `s3://<ACCESS_KEY_ID>:<SECRET_ACCESS_KEY>@<host>/<bucket>[/<prefix>]`（https。`s3+http://` は http）
 * - `file:///path/to/dir`
 * - クエリ: `keep`（残す世代数）、`interval`（定期バックアップの間隔・分）、`region`、`previous`（鍵を替えるときの旧 SECRET）
 * エラーメッセージには URL を含めない（認証情報が入っているため）
 */
export function parseBackupUrl(raw: string | undefined): BackupConfig | null {
  const input = (raw ?? "").trim();
  if (!input) return null;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new BackupUrlError("KANZUME_BACKUP_URL の形式が正しくありません（秘密鍵の / + @ などはパーセントエンコードしてください）");
  }
  const params = url.searchParams;
  const keep = intParam(params, "keep", DEFAULT_KEEP, 1, 1000);
  const intervalMs = intParam(params, "interval", DEFAULT_INTERVAL_MIN, 1, 7 * 24 * 60) * 60_000;
  const previous = params.get("previous") || undefined;

  if (url.protocol === "file:") {
    if (url.host) throw new BackupUrlError("KANZUME_BACKUP_URL の file:// は file:///絶対パス の形式にしてください");
    const dir = decode(url.pathname, "パス");
    if (!dir || dir === "/") throw new BackupUrlError("KANZUME_BACKUP_URL の file:// にディレクトリを指定してください");
    return { kind: "file", dir, secret: params.get("secret") || DEV_SECRET, previous, keep, intervalMs, target: `file://${dir}` };
  }

  if (url.protocol !== "s3:" && url.protocol !== "s3+http:") throw new BackupUrlError("KANZUME_BACKUP_URL は s3:// か file:// で始めてください");
  const accessKeyId = decode(url.username, "アクセスキー");
  const secret = decode(url.password, "シークレットキー");
  if (!accessKeyId || !secret) throw new BackupUrlError("KANZUME_BACKUP_URL に <ACCESS_KEY_ID>:<SECRET_ACCESS_KEY>@ を含めてください");
  if (!url.hostname) throw new BackupUrlError("KANZUME_BACKUP_URL にエンドポイントのホストを含めてください");
  const parts = url.pathname.split("/").filter(Boolean).map((p) => decode(p, "パス"));
  const [bucket, ...rest] = parts;
  if (!bucket) throw new BackupUrlError("KANZUME_BACKUP_URL にバケット名を含めてください（…/<BUCKET>）");
  const prefix = rest.join("/");
  const host = url.host;
  const region = params.get("region") || /\bs3[.-]([a-z0-9-]+)\.amazonaws\.com$/.exec(url.hostname)?.[1] || (url.hostname.endsWith(".amazonaws.com") ? "us-east-1" : "auto");
  return {
    kind: "s3",
    endpoint: `${url.protocol === "s3+http:" ? "http" : "https"}://${host}`,
    bucket,
    prefix,
    accessKeyId,
    secret,
    region,
    previous,
    keep,
    intervalMs,
    target: `${host}/${bucket}${prefix ? `/${prefix}` : ""}`,
  };
}
