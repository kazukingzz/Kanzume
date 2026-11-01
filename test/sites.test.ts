import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { loadConfig } from "../src/config.ts";
import { createServer } from "../src/server.ts";
import { matchHost, parentHost } from "../src/sites.ts";
import { tarGz, tmpDir, toCjs } from "./helpers.ts";

test("Host のサブドメインが既存のサイト名ならそのサイト、それ以外はルートドメイン", () => {
  const has = (n: string) => n === "blog" || n === "tekitou";
  assert.deepEqual(matchHost("blog.tekitou.app", has), { kind: "site", name: "blog" });
  assert.deepEqual(matchHost("BLOG.tekitou.app:443", has), { kind: "site", name: "blog" });
  assert.deepEqual(matchHost("tekitou.app", has), { kind: "root" }, "サイト名と同じでもドメイン本体はルート");
  assert.deepEqual(matchHost("shop.tekitou.app", has), { kind: "root" });
  assert.deepEqual(matchHost("blog.localhost:8080", has), { kind: "site", name: "blog" });
  assert.deepEqual(matchHost("localhost:8080", has), { kind: "root" });
  assert.deepEqual(matchHost("127.0.0.1:8080", has), { kind: "root" });

  assert.deepEqual(matchHost("blog.tekitou.app", has, "tekitou.app"), { kind: "site", name: "blog" });
  assert.deepEqual(matchHost("tekitou.app", has, "tekitou.app"), { kind: "root" });
  assert.deepEqual(matchHost("shop.tekitou.app", has, "tekitou.app"), { kind: "unknown" }, "KANZUME_ORIGIN があれば存在しないサブドメインは区別できる");
  assert.deepEqual(matchHost("a.blog.tekitou.app", has, "tekitou.app"), { kind: "unknown" });
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
  const reserved = await site("shop.localhost:8080", "/_api/deploy", { method: "POST" });
  assert.equal(((await reserved.json()) as { site: string }).site, "shop", "サブドメインでは /_api/ もサイトのパス");
});

test("KANZUME_ORIGIN を設定すると、存在しないサブドメインは 404 になる", async (t) => {
  const { deploy, site } = await start(t, { KANZUME_ORIGIN: "https://tekitou.app" });
  const res = await deploy(counter(t, "blog"));
  assert.equal(((await res.json()) as { url: string }).url, "https://blog.tekitou.app/");
  assert.equal((await site("blog.tekitou.app")).status, 200);
  assert.equal((await site("shop.tekitou.app")).status, 404);
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
  const list = (await (await api("/sites")).json()) as { root: string; sites: { name: string; url: string }[] };
  assert.deepEqual(list.sites.map((s) => [s.name, s.url]), [
    ["blog", `${base.replace("://", "://blog.")}/`],
    ["shop", `${base.replace("://", "://shop.")}/`],
  ]);
  assert.equal(((await (await api("/sites/shop/events")).json()) as { events: unknown[] }).events.length, 2);
  assert.equal((await api("/sites/nope")).status, 404);

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
