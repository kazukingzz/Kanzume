import { randomBytes } from "node:crypto";
import path from "node:path";

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
  /** 管理画面の「サンプルからデプロイ」が使う examples の場所（fork したら自分のリポジトリにする） */
  samplesRepo: string;
  logRetentionHours: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // RENDER_EXTERNAL_URL（*.onrender.com）で固定すると、独自ドメインから開いたときに Origin が一致せずログインできない
  const origin = (env.KANZUME_ORIGIN || "").replace(/\/+$/, "");
  const publicUrl = origin || (env.RENDER_EXTERNAL_URL || "").replace(/\/+$/, "");
  const setupToken = env.KANZUME_SETUP_TOKEN || "";
  return {
    port: Number(env.PORT || 8080),
    dataDir: path.resolve(env.KANZUME_DATA_DIR || "/data"),
    origin: origin || undefined,
    publicUrl: publicUrl || undefined,
    setupToken: setupToken || randomBytes(16).toString("hex"),
    setupTokenGenerated: !setupToken,
    // git の設定は整数しか受け付けないので切り捨てる
    maxUploadBytes: Math.floor(Number(env.KANZUME_MAX_UPLOAD_MB || 50) * 1024 * 1024),
    repoQuotaBytes: Math.floor(Number(env.KANZUME_REPO_QUOTA_MB || 200) * 1024 * 1024),
    workerIdleMs: Number(env.KANZUME_WORKER_IDLE_SEC || 600) * 1000,
    // vm の timeout は実時間で測るので、0.1 CPU で混んでいるときに正常なリクエストを打ち切らないよう長めにする
    cpuTimeoutMs: Number(env.KANZUME_CPU_TIMEOUT_MS || 5000),
    // すべてのサイトの Worker が同じプロセスに載るので、メモリが少ない環境に合わせて少なめにする
    maxWorkers: Number(env.KANZUME_MAX_WORKERS || 5),
    samplesRepo: (env.KANZUME_SAMPLES_REPO || "https://github.com/kazukingzz/Kanzume/tree/main").replace(/\/+$/, ""),
    logRetentionHours: Number(env.KANZUME_LOG_RETENTION_HOURS || 72),
  };
}
