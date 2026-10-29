import { randomBytes } from "node:crypto";
import path from "node:path";

export interface Config {
  port: number;
  dataDir: string;
  origin: string | undefined;
  setupToken: string;
  setupTokenGenerated: boolean;
  maxUploadBytes: number;
  workerIdleMs: number;
  cpuTimeoutMs: number;
  logRetentionHours: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const origin = (env.KANZUME_ORIGIN || env.RENDER_EXTERNAL_URL || "").replace(/\/+$/, "");
  const setupToken = env.KANZUME_SETUP_TOKEN || "";
  return {
    port: Number(env.PORT || 8080),
    dataDir: path.resolve(env.KANZUME_DATA_DIR || "/data"),
    origin: origin || undefined,
    setupToken: setupToken || randomBytes(16).toString("hex"),
    setupTokenGenerated: !setupToken,
    maxUploadBytes: Number(env.KANZUME_MAX_UPLOAD_MB || 50) * 1024 * 1024,
    workerIdleMs: Number(env.KANZUME_WORKER_IDLE_SEC || 600) * 1000,
    // vm の timeout は実時間で測るので、0.1 CPU で混んでいるときに正常なリクエストを打ち切らないよう長めにする
    cpuTimeoutMs: Number(env.KANZUME_CPU_TIMEOUT_MS || 5000),
    logRetentionHours: Number(env.KANZUME_LOG_RETENTION_HOURS || 72),
  };
}
