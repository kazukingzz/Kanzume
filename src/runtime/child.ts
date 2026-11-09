/**
 * Worker を動かす子プロセス（サイトごとに 1 つ）。本体から fork され、本体とは別のユーザーと
 * Node の権限モデル（--permission）で、そのサイトのディレクトリだけを読み書きできる状態で動く。
 *
 * 本体との取り決め:
 * - IPC で { type: "init", release, siteDir, timeout, vars, socket } を受け取り、Worker を読み込んで
 *   Unix ソケットで HTTP を待ち受けたら { type: "ready" }、失敗したら { type: "error", message } を返す
 * - リクエストは本体がソケットに転送する。x-kanzume-id（リクエスト ID）と x-kanzume-url（元の URL）が付く
 * - Worker が例外を出したら 500 と x-kanzume-error: 1 を付け、本文に例外の JSON を入れて返す
 * - 応答を送り終え、waitUntil も終わったら { type: "done", id, logs, droppedLogs, exceptions, subrequests } を返す
 */
import fs from "node:fs";
import http from "node:http";
import { Readable } from "node:stream";
import { Invocation, runInvocation } from "../observability/events.ts";
import type { Release } from "../store.ts";
import { loadWorker, type LoadedWorker } from "./loader.ts";

interface Init {
  type: "init";
  release: Release;
  siteDir: string;
  timeout: number;
  vars: Record<string, unknown>;
  socket: string;
}

const WAIT_UNTIL_LIMIT_MS = 30_000;
/** 本体とのやりとりに使うヘッダー。Worker には渡さない */
const INTERNAL = new Set(["x-kanzume-id", "x-kanzume-url", "connection", "keep-alive", "transfer-encoding"]);
/** 本文を持たない応答 */
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

const send = (message: unknown) => {
  try {
    process.send?.(message);
  } catch {}
};

// Worker のコードが投げっぱなしにした Promise でプロセスごと落とさない（同じサイトのほかのリクエストを巻き込むため）
process.on("unhandledRejection", (err) => console.error("[worker] 未処理の Promise の拒否:", err));

function errorBody(error: unknown, passThrough: boolean): string {
  const e = error as { message?: unknown; name?: unknown; stack?: unknown } | null;
  let message: string;
  try {
    message = String(e?.message ?? error);
  } catch {
    message = "Worker threw exception";
  }
  return JSON.stringify({
    message,
    name: typeof e?.name === "string" ? e.name : "Error",
    stack: typeof e?.stack === "string" ? e.stack : undefined,
    passThrough,
  });
}

function sendError(res: http.ServerResponse, error: unknown, passThrough: boolean): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(500, { "content-type": "application/json; charset=utf-8", "x-kanzume-error": "1" });
  res.end(errorBody(error, passThrough));
}

async function handle(worker: LoadedWorker, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const id = String(req.headers["x-kanzume-id"] ?? "");
  const url = String(req.headers["x-kanzume-url"] ?? "http://localhost/");
  const headers = new Headers();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i].toLowerCase();
    if (!INTERNAL.has(name)) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
  }
  const method = req.method ?? "GET";
  // 本体の toWebRequest と同じ形にする（redirect: "manual" で、fetch(request) の転送がリダイレクトを追わない）
  const request = new Request(url, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : (Readable.toWeb(req) as ReadableStream<Uint8Array>),
    duplex: "half",
    redirect: "manual",
  } as RequestInit);
  const invocation = new Invocation(worker.release.manifest.name, worker.release.id, request, "");
  const result = await runInvocation(invocation, () => worker.fetch(request));

  // 応答を送り終えるまで待つ（送信中のログやストリームのエラーも本体に返すため）
  const sent = new Promise<void>((resolve) => res.once("close", () => resolve()));
  if (result.response) {
    const response = result.response;
    try {
      const out: Record<string, string | string[]> = {};
      for (const [k, v] of response.headers) if (k !== "set-cookie" && !k.startsWith("x-kanzume-")) out[k] = v;
      const cookies = response.headers.getSetCookie();
      if (cookies.length) out["set-cookie"] = cookies;
      res.writeHead(response.status, response.statusText || undefined, out);
    } catch (err) {
      // 不正なステータス（Response.error() の 0 など）や、ヘッダーに使えない文字
      invocation.exception(err);
      await response.body?.cancel().catch(() => {});
      sendError(res, err, false);
      return finish(id, invocation, result.waitUntil, sent);
    }
    if (response.body && method !== "HEAD" && !NULL_BODY.has(response.status)) {
      const body = Readable.fromWeb(response.body as never);
      body.on("error", (err) => {
        invocation.exception(err);
        res.destroy();
      });
      // 本体との接続が切れたら（訪問者が離れたら）Worker のストリームも止める
      res.once("close", () => {
        if (!res.writableFinished) body.destroy();
      });
      body.pipe(res);
    } else {
      await response.body?.cancel().catch(() => {});
      res.end();
    }
  } else {
    sendError(res, result.error, result.passThrough);
  }
  return finish(id, invocation, result.waitUntil, sent);
}

async function finish(id: string, invocation: Invocation, waitUntil: Promise<unknown>[], sent: Promise<void>): Promise<void> {
  // waitUntil と応答の送信を待ってから、ログを本体に返す（本体は done を受け取ってから可観測性に記録する）
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise((resolve) => {
    timer = setTimeout(resolve, WAIT_UNTIL_LIMIT_MS);
    timer.unref();
  });
  await Promise.race([Promise.allSettled([...waitUntil, sent]), limit]);
  clearTimeout(timer);
  const d = invocation.detail;
  send({ type: "done", id, logs: d.logs, droppedLogs: d.droppedLogs, exceptions: d.exceptions, subrequests: d.subrequests });
}

function serve(worker: LoadedWorker, socket: string): Promise<void> {
  const server = http.createServer((req, res) => {
    handle(worker, req, res).catch((err) => {
      console.error("[worker] リクエストの処理に失敗しました:", err);
      try {
        sendError(res, err, false);
      } catch {}
      send({ type: "done", id: String(req.headers["x-kanzume-id"] ?? "") });
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, () => resolve());
  });
}

process.once("message", async (message: Init) => {
  if (message?.type !== "init") return;
  try {
    const worker = await loadWorker(message.release, message.siteDir, message.timeout, message.vars);
    if (fs.existsSync(message.socket)) fs.rmSync(message.socket);
    await serve(worker, message.socket);
    send({ type: "ready" });
  } catch (err) {
    send({ type: "error", message: String((err as Error)?.message ?? err) });
    process.exit(1);
  }
});

// 本体がいなくなったら一緒に終わる
process.on("disconnect", () => process.exit(0));
