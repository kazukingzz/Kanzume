/**
 * 本体（process.ts）と Worker の子プロセス（child.ts）の取り決め。両方がこのファイルを使う。
 *
 * - stdin の 1 行目で子に設定（ChildInit）を渡す。stdin が閉じたら（本体がいなくなったら）子は終わる
 * - 子から本体への知らせは fd 3 に 1 行 1 つの JSON で書く（Node の IPC は使わない）
 *   - { type: "ready" } / { type: "error", message }: Worker を読み込み、Unix ソケットで待ち受けたか
 *   - { type: "alive" }: HEARTBEAT_MS ごと。届かなくなったら、子のイベントループが止まっている（Worker が無限ループしている）
 *   - { type: "done", id, logs, droppedLogs, exceptions, subrequests }: 応答を送り終え、waitUntil も終わった
 * - リクエストは本体がソケットに転送する。x-kanzume-id（リクエスト ID）・x-kanzume-url（元の URL）・
 *   x-kanzume-content-length（元の Content-Length）が付く
 * - 子の応答にはすべて x-kanzume-handled: 1 が付く（Node が手前で断ったもの、431 などと見分けるため）
 * - Worker が例外を出したら 500 と x-kanzume-error（encodeError）で返す（HEAD でも消えないようにヘッダーで）
 */
import type { Release } from "../store.ts";

export interface ChildInit {
  release: Release;
  siteDir: string;
  timeout: number;
  vars: Record<string, unknown>;
  socket: string;
}

/** 応答を送り終えたあと、waitUntil を待つ上限（Cloudflare と同じ 30 秒） */
export const WAIT_UNTIL_LIMIT_MS = 30_000;
/** 本体が done を待つ上限（子が waitUntil を待つ時間に余裕を足したもの） */
export const DONE_TIMEOUT_MS = WAIT_UNTIL_LIMIT_MS + 5_000;
/** 子が alive を送る間隔 */
export const HEARTBEAT_MS = 1_000;
/** 子からの知らせ 1 行の上限（ログ 100 件 × 4 KiB と例外 20 件を収められる大きさ） */
export const MAX_LINE_BYTES = 2 * 1024 * 1024;
/** 例外の情報の上限（ヘッダーと知らせに入れるため） */
export const MAX_ERROR_MESSAGE = 8 * 1024;
export const MAX_ERROR_STACK = 16 * 1024;
export const MAX_ERROR_NAME = 200;
/** 本文を持たない応答のステータス */
export const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

export interface ErrorInfo {
  message: string;
  name: string;
  stack?: string;
  passThrough: boolean;
}

/** Worker の例外を x-kanzume-error ヘッダーの値（base64url の JSON）にする */
export function encodeError(error: unknown, passThrough: boolean): string {
  const e = error as { message?: unknown; name?: unknown; stack?: unknown } | null;
  let message: string;
  try {
    message = String(e?.message ?? error);
  } catch {
    message = "Worker threw exception";
  }
  const info: ErrorInfo = {
    message: message.slice(0, MAX_ERROR_MESSAGE),
    name: typeof e?.name === "string" ? e.name.slice(0, MAX_ERROR_NAME) : "Error",
    stack: typeof e?.stack === "string" ? e.stack.slice(0, MAX_ERROR_STACK) : undefined,
    passThrough,
  };
  return Buffer.from(JSON.stringify(info)).toString("base64url");
}

/** x-kanzume-error を読む。子は信頼できないので、壊れたものや大きすぎるものは丸める */
export function decodeError(value: string): ErrorInfo {
  try {
    const info = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    return {
      message: typeof info.message === "string" ? info.message.slice(0, MAX_ERROR_MESSAGE) : "Worker threw exception",
      name: typeof info.name === "string" ? info.name.slice(0, MAX_ERROR_NAME) : "Error",
      stack: typeof info.stack === "string" ? info.stack.slice(0, MAX_ERROR_STACK) : undefined,
      passThrough: info.passThrough === true,
    };
  } catch {
    return { message: "Worker threw exception", name: "Error", passThrough: false };
  }
}
