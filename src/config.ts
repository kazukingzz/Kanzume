import { randomBytes } from "node:crypto";
import path from "node:path";
import { parseBackupUrl, type BackupConfig } from "./backup/url.ts";

export interface Config {
  port: number;
  dataDir: string;
  /** KANZUME_ORIGIN で固定した公開 URL。未設定ならリクエストの Host から決める */
  origin: string | undefined;
  /** 起動ログに出す管理画面の URL 用 */
  publicUrl: string | undefined;
  setupToken: string;
  setupTokenGenerated: boolean;
  maxUploadBytes: number;
  /** リポジトリ 1 つあたりの容量の上限 */
  repoQuotaBytes: number;
  workerIdleMs: number;
  cpuTimeoutMs: number;
  maxWorkers: number;
  /** 管理画面の「GitHub の公開リポジトリから」に出すサンプル（examples）の場所（fork したら自分のリポジトリにする） */
  samplesRepo: string;
  logRetentionHours: number;
  /** Worker の動かし方。process はサイトごとの子プロセス（既定）、inline は本体と同じプロセス（開発用） */
  isolation: "process" | "inline";
  /** KANZUME_BACKUP_URL。未設定なら null（バックアップしない） */
  backup: BackupConfig | null;
}

/** 環境変数の値が使えないとき（起動を止める） */
export class EnvError extends Error {}

/** 数値の環境変数。未設定なら既定値、数値でない・範囲外ならエラー（NaN のまま使うと上限が効かなくなる） */
function num(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) throw new EnvError(`${name} は ${min} 以上 ${max} 以下の数にしてください（${raw}）`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // ホスティングの URL（*.up.railway.app など）を KANZUME_ORIGIN の代わりには使わない。
  // 固定すると、独自ドメインから開いたときに Origin が一致せずログインできないため（起動ログに出すだけ）
  const origin = (env.KANZUME_ORIGIN || "").replace(/\/+$/, "");
  const publicUrl = origin || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : "");
  const setupToken = env.KANZUME_SETUP_TOKEN || "";
  return {
    port: num(env, "PORT", 8080, 0, 65535),
    dataDir: path.resolve(env.KANZUME_DATA_DIR || "/data"),
    origin: origin || undefined,
    publicUrl: publicUrl || undefined,
    setupToken: setupToken || randomBytes(16).toString("hex"),
    setupTokenGenerated: !setupToken,
    // git の設定は整数しか受け付けないので切り捨てる
    maxUploadBytes: Math.floor(num(env, "KANZUME_MAX_UPLOAD_MB", 50, 0.01, 4096) * 1024 * 1024),
    repoQuotaBytes: Math.floor(num(env, "KANZUME_REPO_QUOTA_MB", 200, 0.01, 1024 * 1024) * 1024 * 1024),
    workerIdleMs: num(env, "KANZUME_WORKER_IDLE_SEC", 600, 1) * 1000,
    // vm の timeout は実時間で測るので、0.1 CPU で混んでいるときに正常なリクエストを打ち切らないよう長めにする
    cpuTimeoutMs: num(env, "KANZUME_CPU_TIMEOUT_MS", 5000, 1),
    // Worker のある（動的な）サイトは、サイトごとに子プロセス（それぞれ数十 MiB）を使う。メモリが少ない環境に合わせて少なめにする
    maxWorkers: num(env, "KANZUME_MAX_WORKERS", 5, 1, 1000),
    samplesRepo: (env.KANZUME_SAMPLES_REPO || "https://github.com/kazukingzz/Kanzume/tree/main").replace(/\/+$/, ""),
    logRetentionHours: num(env, "KANZUME_LOG_RETENTION_HOURS", 72, 1),
    backup: parseBackupUrl(env.KANZUME_BACKUP_URL),
    isolation: env.KANZUME_ISOLATION === "inline" ? "inline" : "process",
  };
}
