import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { loadConfig } from "../src/config.ts";
import { createServer } from "../src/server.ts";
import { matchHost, parentHost } from "../src/sites.ts";
import { tarGz, tmpDir, toCjs } from "./helpers.ts";

const ids = (has: (n: string) => boolean) => (n: string) => (has(n) ? n : undefined);

test("Host のサブドメインが既存のサイト名ならそのサイト、それ以外はルートドメイン", () => {
  const has = (n: string) => n === "blog" || n === "tekitou";
  assert.deepEqual(matchHost("blog.tekitou.app", ids(has)), { kind: "site", name: "blog" });
  assert.deepEqual(matchHost("BLOG.tekitou.app:443", ids(has)), { kind: "site", name: "blog" });
  assert.deepEqual(matchHost("tekitou.app", ids(has)), { kind: "root" }, "サイト名と同じでもドメイン本体はルート");
  assert.deepEqual(matchHost("shop.tekitou.app", ids(has)), { kind: "root" });
  assert.deepEqual(matchHost("blog.localhost:8080", ids(has)), { kind: "site", name: "blog" });
  assert.deepEqual(matchHost("localhost:8080", ids(has)), { kind: "root" });
  assert.deepEqual(matchHost("127.0.0.1:8080", ids(has)), { kind: "root" });
  assert.deepEqual(matchHost("127.0.0.1", ids((n) => n === "127")), { kind: "root" }, "IP アドレスの先頭の数字はサイト名にしない");
  assert.deepEqual(matchHost("[::1]:8080", ids(has)), { kind: "root" });

  assert.deepEqual(matchHost("blog.tekitou.app", ids(has), "tekitou.app"), { kind: "site", name: "blog" });
  assert.deepEqual(matchHost("tekitou.app", ids(has), "tekitou.app"), { kind: "root" });
  assert.deepEqual(matchHost("shop.tekitou.app", ids(has), "tekitou.app"), { kind: "other" }, "ルートドメインが決まっていれば、存在しないサブドメインはサイトでもルートでもない");
  assert.deepEqual(matchHost("a.blog.tekitou.app", ids(has), "tekitou.app"), { kind: "other" });
  assert.deepEqual(matchHost("fa.tekitou.app", ids(has), "tekitou.app"), { kind: "other" });
  assert.deepEqual(matchHost("kanzume-abcd.onrender.com", ids(has), "tekitou.app"), { kind: "other" });
  assert.equal(parentHost("blog.tekitou.app:8080"), "tekitou.app:8080");
});

async function start(t: TestContext, env: Record<string, string> = {}) {
  const app = await createServer(loadConfig({ KANZUME_DATA_DIR: tmpDir(t), KANZUME_SETUP_TOKEN: "setup", ...env }));
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    await app.state.flush();
  });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const deploy = (body: Buffer) =>
    fetch(`${base}/_api/deploy`, { method: "POST", headers: { authorization: `Bearer ${app.state.deployToken}` }, body: new Uint8Array(body) });
  // テストでは *.localhost を名前解決できないので、Host の代わりに X-Forwarded-Host でサブドメインを指定する
  const site = (host: string, path = "/", init: RequestInit = {}) =>
    fetch(`${base}${path}`, { redirect: "manual", ...init, headers: { "x-forwarded-host": host, ...(init.headers ?? {}) } });
  return { ...app, base, deploy, site };
}

const counter = (t: TestContext, name: string) =>
  tarGz(t, {
    "wrangler.jsonc": JSON.stringify({ name, main: "src/index.ts", kv_namespaces: [{ binding: "KV", id: "x" }], r2_buckets: [{ binding: "R2", bucket_name: "files" }] }),
    ...toCjs(t, {
      "worker/index.js": `export default {
        async fetch(request, env) {
          const n = Number((await env.KV.get("n")) ?? 0) + 1;
          await env.KV.put("n", String(n));
          if (n === 1) await env.R2.put("owner", "${name}");
          return Response.json({ site: "${name}", n, owner: await (await env.R2.get("owner")).text(), host: new URL(request.url).host });
        }
      }`,
    }),
  });

test("サイトはサブドメインで分かれ、同じ binding 名の KV / R2 でもデータは混ざらない", async (t) => {
  const { deploy, site, sites } = await start(t);
  assert.equal((await deploy(counter(t, "blog"))).status, 200);
  assert.equal((await deploy(counter(t, "shop"))).status, 200);
  assert.deepEqual(sites.list().map((s) => s.name), ["blog", "shop"]);
  assert.equal(sites.root, "blog", "最初のサイトがルートドメインでも配信される");

  await site("blog.localhost:8080");
  await site("blog.localhost:8080");
  assert.deepEqual(await (await site("blog.localhost:8080")).json(), { site: "blog", n: 3, owner: "blog", host: "blog.localhost:8080" });
  assert.deepEqual(await (await site("shop.localhost:8080")).json(), { site: "shop", n: 1, owner: "shop", host: "shop.localhost:8080" });
  assert.equal(((await (await site("localhost:8080")).json()) as { site: string }).site, "blog");

  const admin = await site("shop.localhost:8080", "/_admin/kanzume");
  assert.equal(admin.status, 302, "サイトのサブドメインでは管理画面を開かない");
  assert.equal(admin.headers.get("location"), "http://localhost:8080/_admin/kanzume");
  // デプロイと git はトークンを受け取るので、サイトのサブドメインでも Kanzume が受ける（Worker に Authorization を渡さない）
  const reserved = await site("shop.localhost:8080", "/_api/deploy", { method: "POST", headers: { authorization: "Bearer secret-token" } });
  assert.equal(reserved.status, 401);
  assert.equal((await site("shop.localhost:8080", "/_git/shop.git/info/refs?service=git-upload-pack")).status, 401);
  assert.equal(((await (await site("shop.localhost:8080", "/_api/other")).json()) as { site: string }).site, "shop", "ほかの /_api/ はサイトのパス");
});

test("自動でルートになるのは Kanzume で最初にデプロイしたサイトだけ。外したり消したりしても、ほかのサイトは自動でルートにならない", async (t) => {
  const { deploy, sites } = await start(t);
  await deploy(counter(t, "blog"));
  assert.equal(sites.root, "blog");

  await sites.setRoot(null);
  await deploy(counter(t, "shop"));
  assert.equal(sites.root, null, "ルートを外した後のデプロイではルートにしない");

  await sites.setRoot("shop");
  await sites.remove("shop");
  assert.equal(sites.root, null);
  await deploy(counter(t, "docs"));
  assert.equal(sites.root, null, "ルートのサイトを消した後のデプロイでもルートにしない");

  // 再起動しても覚えている
  await sites.init();
  assert.equal(sites.rootDecided, true);
});

test("_root がなくても、ほかのサイトがデプロイ済みなら自動でルートにしない（以前から使っている環境）", async (t) => {
  const { deploy, sites } = await start(t);
  await deploy(counter(t, "blog"));
  fs.rmSync(path.join(sites.dir, "_root"));
  await sites.init();
  assert.equal(sites.root, null);
  assert.equal(sites.rootDecided, false);
  await deploy(counter(t, "shop"));
  assert.equal(sites.root, null);
  await deploy(counter(t, "blog"));
  assert.equal(sites.root, null);
});

test("KANZUME_ORIGIN を設定すると、存在しないサブドメインは 404 になる", async (t) => {
  const { deploy, site } = await start(t, { KANZUME_ORIGIN: "https://tekitou.app" });
  const res = await deploy(counter(t, "blog"));
  assert.equal(((await res.json()) as { url: string }).url, "https://tekitou.app/", "ルートで配信するサイトはルートの URL を返す");
  const shop = await deploy(counter(t, "shop"));
  assert.equal(((await shop.json()) as { url: string }).url, "https://shop.tekitou.app/");
  assert.equal((await site("blog.tekitou.app")).status, 200);
  assert.equal((await site("nope.tekitou.app")).status, 404);
  assert.equal((await site("blog.tekitou.app", "/_admin/kanzume")).headers.get("location"), "https://tekitou.app/_admin/kanzume");
});

test("ログとデプロイ履歴はサイトごとに分かれ、サイトを消しても他のサイトのものは残る", async (t) => {
  const { base, deploy, site, sites, state, history, observability } = await start(t);
  await deploy(counter(t, "blog"));
  await deploy(counter(t, "shop"));
  await site("blog.localhost");
  await site("shop.localhost");
  await site("shop.localhost");
  assert.equal(observability.events("blog").length, 1);
  assert.equal(observability.events("shop").length, 2);
  assert.equal(history.list("shop").length, 1);

  const cookie = `kanzume_session=${await state.createSession()}`;
  const api = (path: string, init: RequestInit = {}) =>
    fetch(`${base}/_admin/kanzume/api${path}`, { ...init, headers: { cookie, origin: base, "content-type": "application/json", ...(init.headers ?? {}) } });
  const list = (await (await api("/sites")).json()) as { root: string; sites: { name: string; url: string; subdomainUrl: string; kind: string | null }[] };
  assert.deepEqual(list.sites.map((s) => s.kind), ["dynamic", "dynamic"], "Worker のあるサイトは動的");
  assert.deepEqual(list.sites.map((s) => [s.name, s.url, s.subdomainUrl]), [
    ["blog", `${base}/`, `${base.replace("://", "://blog.")}/`],
    ["shop", `${base.replace("://", "://shop.")}/`, `${base.replace("://", "://shop.")}/`],
  ]);
  assert.equal(((await (await api("/sites/shop/events")).json()) as { events: unknown[] }).events.length, 2);
  assert.equal((await api("/sites/nope")).status, 404);
  assert.deepEqual(await (await api("/samples")).json(), {
    worker: "https://github.com/kazukingzz/Kanzume/tree/main/examples/worker",
    portfolio: "https://github.com/kazukingzz/Kanzume/tree/main/examples/portfolio",
  });

  assert.equal((await api("/root-site", { method: "POST", body: JSON.stringify({ name: "shop" }) })).status, 200);
  assert.equal(sites.root, "shop");

  assert.equal((await api("/sites/shop", { method: "DELETE" })).status, 200);
  assert.deepEqual(sites.list().map((s) => s.name), ["blog"]);
  assert.equal(sites.root, null, "ルートで配信していたサイトを消すと、ルートは空になる");
  assert.equal(observability.events("shop").length, 0);
  assert.equal(history.list("shop").length, 0);
  assert.equal(observability.events("blog").length, 1);
  assert.equal(history.list("blog").length, 1);
  assert.equal((await site("shop.localhost")).status, 200, "消したサイトのサブドメインはルートドメイン扱い（空のページ）");
});

test("ルートドメインを管理画面で設定すると、サイトはそのサブドメインになり、管理画面はサイト以外のホストで開ける", async (t) => {
  const { base, deploy, site, state, sites } = await start(t);
  const cookie = `kanzume_session=${await state.createSession()}`;
  // fa.tekitou.app で管理画面を開いている（Origin も fa.tekitou.app）
  const admin = (p: string, init: RequestInit = {}, host = "fa.tekitou.app") =>
    fetch(`${base}/_admin/kanzume/api${p}`, {
      ...init,
      headers: { cookie, origin: `https://${host}`, "x-forwarded-host": host, "x-forwarded-proto": "https", "content-type": "application/json" },
    });
  const setDomain = (domain: string) => admin("/domain", { method: "POST", body: JSON.stringify({ domain }) });

  assert.equal((await setDomain("not a domain")).status, 400);
  assert.equal((await setDomain("https://Tekitou.app/")).status, 200);
  assert.equal(state.domain, "tekitou.app", "スキームと末尾の / を外し、小文字にそろえる");

  const res = await deploy(counter(t, "blog"));
  assert.equal(((await res.json()) as { url: string }).url, `${base.split("://")[0]}://tekitou.app/`, "最初のサイトはルートなので、ルートドメインの URL");
  await deploy(counter(t, "shop"));
  const overview = (await (await admin("/overview")).json()) as { domain: { value: string; effective: string; current: string } };
  assert.deepEqual(overview.domain, { value: "tekitou.app", fromEnv: false, effective: "tekitou.app", current: "fa.tekitou.app" });
  const list = (await (await admin("/sites")).json()) as { sites: { name: string; url: string }[] };
  assert.deepEqual(list.sites.map((s) => s.url), ["https://tekitou.app/", "https://shop.tekitou.app/"]);

  assert.equal(((await (await site("tekitou.app")).json()) as { site: string }).site, "blog", "ルートドメインでルートのサイト");
  assert.equal(((await (await site("shop.tekitou.app")).json()) as { site: string }).site, "shop");
  assert.equal((await site("fa.tekitou.app")).status, 404, "サイトでもルートでもないホストではサイトを出さない");
  assert.equal((await site("fa.tekitou.app", "/_admin/kanzume")).status, 200, "管理画面はそのホストでも開ける");
  assert.equal((await site("nope.tekitou.app")).status, 404);
  assert.equal((await site("shop.tekitou.app", "/_admin/kanzume")).headers.get("location"), "http://tekitou.app/_admin/kanzume", "サイトのサブドメインからはルートドメインの管理画面へ");

  assert.equal((await setDomain("")).status, 200);
  assert.equal(state.domain, null, "空にすると自動に戻る");
  assert.equal(sites.root, "blog");
});

test("KANZUME_ORIGIN があるときは管理画面からドメインを変えられない", async (t) => {
  const { base, state } = await start(t, { KANZUME_ORIGIN: "https://tekitou.app" });
  const cookie = `kanzume_session=${await state.createSession()}`;
  const res = await fetch(`${base}/_admin/kanzume/api/domain`, { method: "POST", headers: { cookie, origin: base, "content-type": "application/json" }, body: JSON.stringify({ domain: "x.example" }) });
  assert.equal(res.status, 409);
});
