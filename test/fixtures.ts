import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { SESSION_COOKIE } from "../src/admin/session.ts";
import { loadConfig } from "../src/config.ts";
import { createServer } from "../src/server.ts";
import { nameInTarGz } from "./helpers.ts";

type ServerOptions = Parameters<typeof createServer>[1];

/** テスト用のパスキー（中身は確かめないので形だけ） */
export const fakeCredential = (id: string, userId?: string) => ({ id, publicKey: "AAAA", counter: 0, createdAt: new Date().toISOString(), userId });

/**
 * Kanzume を一時ディレクトリで起動する。後片付けは 1 つの t.after で、起動と逆の順に行う
 * （Worker の子プロセス → サーバー → 状態の書き込み → データのディレクトリ）
 */
export async function startApp(t: TestContext, env: Record<string, string> = {}, options: ServerOptions = {}) {
  const dataDir = env.KANZUME_DATA_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), "kanzume-test-"));
  const app = await createServer(loadConfig({ KANZUME_SETUP_TOKEN: "setup", ...env, KANZUME_DATA_DIR: dataDir }), options);
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    app.runtime.close();
    await new Promise((resolve) => app.server.close(resolve));
    await app.state.flush();
    if (!env.KANZUME_DATA_DIR) fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  /** 最初の管理者の個人トークン（GitHub Actions・git push 用） */
  const { token } = await app.state.createUserToken(app.state.setupUserId, "test", null);

  /** /_api/deploy（GitHub Actions と同じ）でデプロイする。サイトがなければ先に作る */
  const deploy = async (body: Buffer, options: { site?: string; token?: string } = {}) => {
    const site = options.site ?? nameInTarGz(body);
    if (!app.sites.has(site)) await app.sites.ensure(site);
    return fetch(`${base}/_api/deploy`, {
      method: "POST",
      headers: { authorization: `Bearer ${options.token ?? token}`, "x-kanzume-site": site },
      body: new Uint8Array(body),
    });
  };

  /** テストでは *.localhost を名前解決できないので、Host の代わりに X-Forwarded-Host でサブドメインを指定する */
  const site = (host: string, p = "/", init: RequestInit = {}) =>
    fetch(`${base}${p}`, { redirect: "manual", ...init, headers: { "x-forwarded-host": host, ...(init.headers ?? {}) } });

  /** パスキーを持つ管理者としてログインした Cookie */
  const adminCookie = async () => {
    if (!app.state.credentials.some((c) => c.userId === app.state.setupUserId)) await app.state.addCredential(fakeCredential("admin"));
    return cookieFor(await app.state.createSession());
  };

  /** 管理画面の API を呼ぶ（cookie が null ならログインしていない） */
  const api =
    (cookie: string | null) =>
    (p: string, method = "GET", body?: unknown) =>
      fetch(`${base}/_admin/kanzume/api${p}`, {
        method,
        headers: { ...(cookie ? { cookie } : {}), origin: base, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

  return { ...app, base, dataDir, token, deploy, site, adminCookie, api };
}

export type App = Awaited<ReturnType<typeof startApp>>;

export const cookieFor = (session: string) => `${SESSION_COOKIE}=${session}`;
