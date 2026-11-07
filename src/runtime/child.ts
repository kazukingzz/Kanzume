/**
 * Worker を動かす子プロセス（サイトごとに 1 つ）。本体から fork され、本体とは別のユーザーと
 * Node の権限モデル（--permission）で、そのサイトのディレクトリだけを読み書きできる状態で動く。
 *
 * 本体との取り決め:
 * - IPC で { type: "init", release, siteDir, timeout, vars, socket } を受け取り、Worker を読み込んで
 *   Unix ソケットで HTTP を待ち受けたら { type: "ready" }、失敗したら { type: "error", message } を返す
 * - リクエストは本体がソケットに転送する。x-kanzume-id（リクエスト ID）と x-kanzume-url（元の URL）が付く
 * - Worker が例外を出したら 500 と x-kanzume-error（JSON）で返す
 * - ログと waitUntil が終わったら { type: "done", id, logs, droppedLogs, exceptions, subrequests } を返す
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
const INTERNAL = new Set(["x-kanzume-id", "x-kanzume-url", "connection", "keep-alive", "transfer-encoding", "host"]);

const send = (message: unknown) => process.send?.(message);

function serve(worker: LoadedWorker, socket: string): Promise<void> {
  const server = http.createServer(async (req, res) => {
    const id = String(req.headers["x-kanzume-id"] ?? "");
    const url = String(req.headers["x-kanzume-url"] ?? "http://localhost/");
    const headers = new Headers();
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i].toLowerCase();
      if (!INTERNAL.has(name)) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
    }
    const method = req.method ?? "GET";
    const request = new Request(url, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : (Readable.toWeb(req) as ReadableStream<Uint8Array>),
      duplex: "half",
    } as RequestInit);
    const invocation = new Invocation(worker.release.manifest.name, worker.release.id, request, "");
    const result = await runInvocation(invocation, () => worker.fetch(request));

    if (result.response) {
      const out: Record<string, string | string[]> = {};
      for (const [k, v] of result.response.headers) if (k !== "set-cookie") out[k] = v;
      const cookies = result.response.headers.getSetCookie();
      if (cookies.length) out["set-cookie"] = cookies;
      res.writeHead(result.response.status, result.response.statusText, out);
      if (result.response.body && method !== "HEAD") {
        Readable.fromWeb(result.response.body as never)
          .on("error", (err) => {
            invocation.exception(err);
            res.destroy();
          })
          .pipe(res);
      } else res.end();
    } else {
      const error = result.error as Error;
      res.writeHead(500, {
        "content-type": "text/plain; charset=utf-8",
        "x-kanzume-error": encodeURIComponent(JSON.stringify({ message: String(error?.message ?? error), name: error?.name ?? "Error", stack: typeof error?.stack === "string" ? error.stack : undefined, passThrough: result.passThrough })),
      });
      res.end("Worker threw exception");
    }

    // waitUntil を待ってから、ログを本体に返す（本体は done を受け取ってから可観測性に記録する）
    const limit = new Promise((resolve) => setTimeout(resolve, WAIT_UNTIL_LIMIT_MS).unref());
    await Promise.race([Promise.allSettled(result.waitUntil), limit]);
    const d = invocation.detail;
    send({ type: "done", id, logs: d.logs, droppedLogs: d.droppedLogs, exceptions: d.exceptions, subrequests: d.subrequests });
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
