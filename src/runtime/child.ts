/**
 * Worker を動かす子プロセス（サイトごとに 1 つ）。本体から起動され、本体とは別のユーザーと
 * Node の権限モデル（--permission）で、そのサイトのリリースと KV / R2 だけを扱える状態で動く。
 *
 * 本体との取り決め（Node の IPC は使わない。本体が自分で読む、ただのパイプにする）:
 * - stdin の 1 行目で { release, siteDir, timeout, vars, socket } を受け取る。stdin が閉じたら（本体がいなくなったら）終わる
 * - 本体への知らせは fd 3 に 1 行 1 つの JSON で書く。Worker を読み込み、Unix ソケットで HTTP を待ち受けたら
 *   { type: "ready" }、失敗したら { type: "error", message }
 * - リクエストは本体がソケットに転送する。x-kanzume-id（リクエスト ID）・x-kanzume-url（元の URL）・
 *   x-kanzume-content-length（元の Content-Length）が付く
 * - 応答にはすべて x-kanzume-handled: 1 を付ける（Node が手前で断ったもの、431 などと見分けるため）
 * - Worker が例外を出したら 500 と x-kanzume-error（base64url の JSON）で返す（HEAD でも消えないようにヘッダーで）
 * - 応答を送り終え、waitUntil も終わったら { type: "done", id, logs, droppedLogs, exceptions, subrequests } を書く
 */
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import { Readable } from "node:stream";
import { setBusyTimeout } from "../bindings/db.ts";
import { Invocation, runInvocation } from "../observability/events.ts";
import type { Release } from "../store.ts";
import { loadWorker, type LoadedWorker } from "./loader.ts";

interface Init {
  release: Release;
  siteDir: string;
  timeout: number;
  vars: Record<string, unknown>;
  socket: string;
}

const WAIT_UNTIL_LIMIT_MS = 30_000;
/** 本体とのやりとりに使うヘッダー。Worker には渡さない */
const INTERNAL = new Set(["x-kanzume-id", "x-kanzume-url", "x-kanzume-content-length", "connection", "keep-alive", "transfer-encoding"]);
/** 本文を持たない応答 */
const NULL_BODY = new Set([101, 103, 204, 205, 304]);
/** 例外の情報の上限（ヘッダーに入れるため） */
const MAX_ERROR_MESSAGE = 8 * 1024;
const MAX_ERROR_STACK = 16 * 1024;

const out = new net.Socket({ fd: 3, readable: false });
out.on("error", () => process.exit(0));
const send = (message: unknown) => {
  try {
    out.write(`${JSON.stringify(message)}\n`);
  } catch {}
};

// 子が止まっても困るのはこのサイトだけなので、KV / R2 のロックは長めに待つ
setBusyTimeout(5000);

// Worker のコードが投げっぱなしにした Promise でプロセスごと落とさない（同じサイトのほかのリクエストを巻き込むため）
process.on("unhandledRejection", (err) => console.error("[worker] 未処理の Promise の拒否:", err));

function errorHeader(error: unknown, passThrough: boolean): string {
  const e = error as { message?: unknown; name?: unknown; stack?: unknown } | null;
  let message: string;
  try {
    message = String(e?.message ?? error);
  } catch {
    message = "Worker threw exception";
  }
  const info = {
    message: message.slice(0, MAX_ERROR_MESSAGE),
    name: typeof e?.name === "string" ? e.name.slice(0, 200) : "Error",
    stack: typeof e?.stack === "string" ? e.stack.slice(0, MAX_ERROR_STACK) : undefined,
    passThrough,
  };
  return Buffer.from(JSON.stringify(info)).toString("base64url");
}

function sendError(res: http.ServerResponse, error: unknown, passThrough: boolean): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(500, { "content-type": "text/plain; charset=utf-8", "x-kanzume-handled": "1", "x-kanzume-error": errorHeader(error, passThrough) });
  res.end("Worker threw exception");
}

async function handle(worker: LoadedWorker, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const id = String(req.headers["x-kanzume-id"] ?? "");
  const url = String(req.headers["x-kanzume-url"] ?? "http://localhost/");
  const headers = new Headers();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i].toLowerCase();
    if (!INTERNAL.has(name)) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
  }
  // 本文は chunked で受け取るので、元の Content-Length を戻す（Worker が大きさを確かめられるように）
  const length = req.headers["x-kanzume-content-length"];
  if (typeof length === "string" && /^\d+$/.test(length)) headers.set("content-length", length);
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
      const outHeaders: Record<string, string | string[]> = {};
      for (const [k, v] of response.headers) if (k !== "set-cookie" && !k.startsWith("x-kanzume-")) outHeaders[k] = v;
      const cookies = response.headers.getSetCookie();
      if (cookies.length) outHeaders["set-cookie"] = cookies;
      outHeaders["x-kanzume-handled"] = "1";
      res.writeHead(response.status, response.statusText || undefined, outHeaders);
    } catch (err) {
      // 不正なステータス（Response.error() の 0 など）や、ヘッダーに使えない文字。記録は本体が例外として行う
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
  // 応答を送り終えるのを待ち（長いストリームでも）、そのあと waitUntil を最大 30 秒待ってから、ログを本体に返す。
  // 本体は done を受け取るまで、このリクエストを処理中として扱う
  await sent;
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise((resolve) => {
    timer = setTimeout(resolve, WAIT_UNTIL_LIMIT_MS);
    timer.unref();
  });
  await Promise.race([Promise.allSettled(waitUntil), limit]);
  clearTimeout(timer);
  const d = invocation.detail;
  send({ type: "done", id, logs: d.logs, droppedLogs: d.droppedLogs, exceptions: d.exceptions, subrequests: d.subrequests });
}

function serve(worker: LoadedWorker, socket: string): Promise<void> {
  // 本体が付け足すヘッダー（元の URL など）の分、本体（既定 16 KiB）より大きくしておく（本体が受けたものを子が断らないように）
  const server = http.createServer({ maxHeaderSize: 256 * 1024 }, (req, res) => {
    let reported = false;
    handle(worker, req, res)
      .then(() => (reported = true))
      .catch((err) => {
        console.error("[worker] リクエストの処理に失敗しました:", err);
        try {
          sendError(res, err, false);
        } catch {}
        if (!reported) send({ type: "done", id: String(req.headers["x-kanzume-id"] ?? "") });
      });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, () => resolve());
  });
}

async function start(init: Init): Promise<void> {
  try {
    const worker = await loadWorker(init.release, init.siteDir, init.timeout, init.vars);
    if (fs.existsSync(init.socket)) fs.rmSync(init.socket);
    await serve(worker, init.socket);
    send({ type: "ready" });
  } catch (err) {
    send({ type: "error", message: String((err as Error)?.message ?? err) });
    out.end(() => process.exit(1));
  }
}

// stdin の 1 行目が設定。そのあと stdin が閉じたら（本体がいなくなったら）一緒に終わる
let input = "";
let started = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  if (started) return;
  input += chunk;
  const nl = input.indexOf("\n");
  if (nl === -1) return;
  started = true;
  void start(JSON.parse(input.slice(0, nl)) as Init);
});
process.stdin.on("end", () => process.exit(0));
