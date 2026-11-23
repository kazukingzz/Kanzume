import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { tarGz, tmpDir, toCjs, until } from "./helpers.ts";
import { startApp } from "./fixtures.ts";
import { DatabaseSync } from "node:sqlite";
import { openEventsDb, openMetaDb } from "../src/observability/db.ts";
import { Invocation, Observability } from "../src/observability/events.ts";

async function start(t: TestContext) {
  const app = await startApp(t);
  const auth = { authorization: `Bearer ${app.token}` };
  // ここでは app をルートで配信して確かめる（ルートは管理者が選ぶ）
  await app.sites.ensure("app");
  await app.sites.setRoot("app");
  return { ...app, auth };
}

function bundle(t: TestContext, source: string, extra: Record<string, string> = {}) {
  return tarGz(t, {
    "wrangler.jsonc": JSON.stringify({ name: "app", main: "src/index.ts", compatibility_date: "2026-10-01", assets: { directory: "public" } }),
    ...toCjs(t, { "worker/index.js": source }),
    "assets/index.html": "<h1>hi</h1>",
    ...extra,
  });
}

const META = {
  ".kanzume/meta.json": JSON.stringify({ source: { repository: "me/app", ref: "main", sha: "abc1234def", actor: "me", commitMessage: "初回" } }),
  ".kanzume/build.log": "$ wrangler deploy --dry-run\nTotal Upload: 1 KiB",
  ".kanzume/sources.json": JSON.stringify([
    { path: "src/index.ts", content: "export default {}" },
    { path: "../../etc/passwd", content: "x" },
  ]),
};

test("成功したデプロイがビルドログ・コミット情報・Kanzume のログ付きで履歴に残る", async (t) => {
  const { deploy, history } = await start(t);
  const res = await deploy(bundle(t, `export default { fetch() { return new Response("ok"); } }`, META));
  const { release } = (await res.json()) as { release: string };

  const [d] = history.list();
  assert.equal(d.status, "success");
  assert.equal(d.release, release);
  assert.deepEqual(d.source, { repository: "me/app", ref: "main", sha: "abc1234def", actor: "me", commitMessage: "初回" });
  const full = history.get(d.id)!;
  assert.match(full.buildLog, /wrangler deploy --dry-run/);
  assert.match(full.log, /Worker を読み込みました/);
  assert.match(full.log, /新しいリリースに切り替えました/);
});

test("読み込みに失敗したデプロイとビルド失敗の報告は失敗として履歴に残る", async (t) => {
  const { base, auth, deploy, history } = await start(t);
  await deploy(bundle(t, `throw new Error("top-level"); export default {}`, META));
  const report = await fetch(`${base}/_api/deploy/report`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ name: "app", error: "wrangler が失敗しました", buildLog: "✘ [ERROR] Could not resolve", source: { sha: "fff" } }),
  });
  assert.equal(report.status, 200);
  const unauthorized = await fetch(`${base}/_api/deploy/report`, { method: "POST", body: JSON.stringify({ name: "app" }) });
  assert.equal(unauthorized.status, 401);

  const [reported, loadFailed] = history.list();
  assert.equal(reported.status, "failed");
  assert.equal(reported.error, "wrangler が失敗しました");
  assert.match(history.get(reported.id)!.buildLog, /Could not resolve/);
  assert.equal(loadFailed.status, "failed");
  assert.match(loadFailed.error!, /top-level/);
  assert.equal(loadFailed.release, null);
});

test("Worker へのリクエストが console ログ・例外・サブリクエスト（断った宛先も）付きでイベントとして記録される", async (t) => {
  const { base, deploy, observability } = await start(t);
  const target = http.createServer((_, res) => res.end("upstream")).listen(0, "127.0.0.1");
  t.after(() => target.close());
  await new Promise((r) => target.once("listening", r));
  const upstream = `http://127.0.0.1:${(target.address() as AddressInfo).port}/x`;

  const source = `export default {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      console.log("path is", url.pathname, { n: 1 });
      if (url.pathname === "/boom") throw new TypeError("壊れた");
      if (url.pathname === "/sub") { await fetch(${JSON.stringify(upstream)}).catch((e) => console.warn("fetched", e.name)); }
      ctx.waitUntil(new Promise((r) => setTimeout(r, 20)).then(() => console.log("after response")));
      return new Response("ok");
    }
  }`;
  await deploy(bundle(t, source));
  await fetch(`${base}/hello?x=1`);
  await fetch(`${base}/boom`);
  await fetch(`${base}/sub`);
  await fetch(`${base}/`);
  await until(() => observability.events("app").length === 4);

  const events = observability.events("app");
  assert.equal(events.length, 4);
  const byPath = (p: string) => events.find((e) => e.path === p)!;
  const [asset, sub, boom, hello] = ["/", "/sub", "/boom", "/hello?x=1"].map(byPath);
  assert.deepEqual([asset.kind, asset.status, asset.path], ["asset", 200, "/"]);
  assert.deepEqual([boom.status, boom.outcome, boom.error], [500, "exception", "TypeError: 壊れた"]);
  assert.deepEqual([hello.kind, hello.method, hello.path, hello.outcome], ["worker", "GET", "/hello?x=1", "ok"]);

  const helloDetail = observability.event("app", hello.id)!.detail;
  assert.deepEqual(
    helloDetail.logs.map((l) => [l.level, l.message]),
    [
      ["log", "path is /hello { n: 1 }"],
      ["log", "after response"],
    ],
  );
  const subDetail = observability.event("app", sub.id)!.detail;
  assert.equal(subDetail.subrequests.length, 1);
  assert.equal(subDetail.subrequests[0].url, upstream);
  assert.equal(subDetail.subrequests[0].status, null, "ループバックのアドレスには接続しない");
  assert.match(String(subDetail.subrequests[0].error), /インターネットのアドレスでない/);
  assert.deepEqual(
    subDetail.logs.map((l) => l.level),
    ["log", "warn", "log"],
  );
  const stack = observability.event("app", boom.id)!.detail.exceptions[0].stack ?? "";
  assert.match(stack, /TypeError: 壊れた\n\s+at .*worker\/index\.cjs/);
  assert.doesNotMatch(stack, /src\/runtime|node:/);

  assert.deepEqual(
    observability.events("app", { result: "error" }).map((e) => e.id),
    [boom.id],
  );
  assert.deepEqual(
    observability.events("app", { kind: "asset" }).map((e) => e.id),
    [asset.id],
  );
  assert.deepEqual(
    observability.events("app", { q: "fetched" }).map((e) => e.id),
    [sub.id],
  );
  assert.deepEqual(
    observability.events("app", { before: events[0].id, limit: 1 }).map((e) => e.id),
    [events[1].id],
  );
});

test("同期処理の時間超過は exceededCpu として記録される", async (t) => {
  const app = await startApp(t, { KANZUME_CPU_TIMEOUT_MS: "100" });
  const base = app.base;
  await app.sites.ensure("app");
  await app.sites.setRoot("app");
  await fetch(`${base}/_api/deploy`, {
    method: "POST",
    headers: { authorization: `Bearer ${app.token}`, "x-kanzume-site": "app" },
    body: new Uint8Array(bundle(t, `export default { fetch() { while (true) {} } }`)),
  });
  assert.equal((await fetch(`${base}/x`)).status, 500);
  // 記録は子プロセスから done が届いてから
  await until(() => app.observability.events("app").length > 0);
  const [e] = app.observability.events("app");
  assert.equal(e.outcome, "exceededCpu");
});

test("メトリクスは期間内のリクエスト数・エラー数・実行時間をバケットごとに集計する", async (t) => {
  const { base, deploy, observability } = await start(t);
  await deploy(bundle(t, `export default { fetch(r) { if (new URL(r.url).pathname === "/e") throw new Error("x"); return new Response("ok"); } }`));
  for (let i = 0; i < 5; i++) await fetch(`${base}/ok`);
  for (let i = 0; i < 2; i++) await fetch(`${base}/e`);
  await fetch(`${base}/`);

  await until(() => observability.metrics("app", "1h").totals.requests === 8);
  const m = observability.metrics("app", "1h");
  assert.equal(m.totals.requests, 8);
  assert.equal(m.totals.worker, 7);
  assert.equal(m.totals.errors, 2);
  assert.equal(m.totals.statuses["5xx"], 2);
  assert.equal(m.buckets.length, 60);
  assert.equal(
    m.buckets.reduce((n, b) => n + b.ok + b.errors, 0),
    8,
  );
  assert.ok(m.totals.p50! > 0 && m.totals.p99! >= m.totals.p50!);

  const old = observability.metrics("app", "1h", Date.now() + 2 * 3600e3);
  assert.equal(old.totals.requests, 0);
});

test("古いイベントは保持期間を過ぎると削除され、サイト削除でも消える", async (t) => {
  const { base, deploy, observability } = await start(t);
  await deploy(bundle(t, `export default { fetch() { return new Response("ok"); } }`));
  await fetch(`${base}/a`);
  await until(() => observability.events("app").length === 1);
  observability.flush();
  observability.prune(Date.now() + 73 * 3600e3);
  assert.equal(observability.events("app").length, 0);
  await fetch(`${base}/b`);
  await until(() => observability.events("app").length === 1);
  observability.clear("app");
  assert.equal(observability.events("app").length, 0);
});

test("管理 API でデプロイ中のコード（ソース・設定・変換後・アセット）を読める", async (t) => {
  const { sites, deploy } = await start(t);
  await deploy(bundle(t, `export default { fetch() { return new Response("ok"); } }`, { ...META, "assets/logo.bin": "\u0000\u0001" }));
  const { listFiles, readFile } = await import("../src/admin/files.ts");
  const release = sites.get("app")!.get()!;
  const groups = listFiles(release);
  assert.deepEqual(
    groups.source.map((f) => f.path),
    ["etc/passwd", "src/index.ts"],
  );
  assert.deepEqual(
    groups.config.map((f) => f.path),
    ["wrangler.jsonc"],
  );
  assert.deepEqual(
    groups.worker.map((f) => f.path),
    ["index.cjs"],
  );
  assert.deepEqual(
    groups.assets.map((f) => f.path),
    ["index.html", "logo.bin"],
  );

  assert.equal(readFile(release, "source", "src/index.ts")?.text, "export default {}");
  assert.match(readFile(release, "config", "wrangler.jsonc")!.text!, /"name":"app"/);
  assert.equal(readFile(release, "assets", "logo.bin")?.binary, true);
  assert.equal(readFile(release, "assets", "../_manifest.json"), null);
  assert.equal(readFile(release, "worker", "../../current"), null);
  assert.equal(readFile(release, "config", "_manifest.json"), null);
});

test("after を指定したら、その次から古い順に limit 件（返すのは新しい順）。間のイベントを飛ばさない", (t) => {
  const meta = new DatabaseSync(":memory:");
  const dir = tmpDir(t);
  const db = openEventsDb(dir, meta);
  const o = new Observability(db, 72);
  t.after(() => {
    o.close();
    db.close();
  });
  for (let i = 0; i < 10; i++) o.record(new Invocation("app", "r1", new Request(`http://x/${i}`), ""), 200, 1);
  o.flush();
  const all = o.events("app", { limit: 200 }).map((e) => e.id);
  const after = o.events("app", { after: all.at(-1), limit: 3 }).map((e) => e.id);
  assert.deepEqual(after, all.slice(-4, -1), "最初の次から 3 件");
});

function memoryObservability(t: TestContext, limits?: ConstructorParameters<typeof Observability>[2]) {
  const db = openEventsDb(tmpDir(t), new DatabaseSync(":memory:"));
  const o = new Observability(db, 72, limits);
  t.after(() => {
    o.close();
    db.close();
  });
  const insert = db.prepare(
    "INSERT INTO events (site, ts, kind, method, path, status, outcome, duration_ms, log_count, detail) VALUES (?, ?, ?, 'GET', '/', ?, ?, ?, 0, ?)",
  );
  return { db, o, insert };
}

test("メトリクスの集計と百分位は、全行を並べて JS で数えたものと同じ", (t) => {
  const { o, insert } = memoryObservability(t);
  const now = Date.now();
  const rows: { ts: number; status: number; outcome: string; d: number; kind: string }[] = [];
  for (let i = 0; i < 500; i++) {
    const row = {
      ts: now - Math.floor(((i * 7919) % 3600) * 1000),
      status: [200, 204, 301, 404, 500, 503][i % 6],
      outcome: i % 11 === 0 ? "exception" : "ok",
      d: ((i * 31) % 97) + 0.5,
      kind: i % 3 ? "worker" : "asset",
    };
    rows.push(row);
    insert.run("app", row.ts, row.kind, row.status, row.outcome, row.d, "{}");
  }
  insert.run("other", now, "worker", 500, "ok", 1, "{}");

  const m = o.metrics("app", "1h", now);
  const pct = (xs: number[], q: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * q))] : null);
  const inRange = rows.filter((r) => r.ts >= m.start);
  const isError = (r: (typeof rows)[number]) => r.status >= 500 || r.outcome !== "ok";
  assert.equal(m.totals.requests, inRange.length);
  assert.equal(m.totals.errors, inRange.filter(isError).length);
  assert.equal(m.totals.worker, inRange.filter((r) => r.kind === "worker").length);
  assert.equal(m.totals.statuses["3xx"], inRange.filter((r) => r.status === 301).length);
  assert.equal(
    m.totals.p50,
    pct(
      inRange.map((r) => r.d),
      0.5,
    ),
  );
  assert.equal(
    m.totals.p95,
    pct(
      inRange.map((r) => r.d),
      0.95,
    ),
  );
  assert.equal(
    m.totals.p99,
    pct(
      inRange.map((r) => r.d),
      0.99,
    ),
  );
  m.buckets.forEach((b, i) => {
    const mine = inRange.filter((r) => Math.min(m.buckets.length - 1, Math.floor((r.ts - m.start) / m.step)) === i);
    assert.equal(b.ok + b.errors, mine.length, `バケット ${i}`);
    assert.equal(b.errors, mine.filter(isError).length);
    assert.equal(
      b.p50,
      pct(
        mine.map((r) => r.d),
        0.5,
      ),
    );
    assert.equal(
      b.p99,
      pct(
        mine.map((r) => r.d),
        0.99,
      ),
    );
  });
});

test("イベントはサイトごとの件数と DB の大きさの上限を超えた分を、古い方から消す", (t) => {
  const { o } = memoryObservability(t, { perSite: 20, maxBytes: 1024 * 1024 });
  for (let i = 0; i < 50; i++) o.record(new Invocation("busy", "r1", new Request(`http://x/${i}`), `/${i}`), 200, 1);
  for (let i = 0; i < 5; i++) o.record(new Invocation("quiet", "r1", new Request(`http://x/${i}`), `/${i}`), 200, 1);
  o.enforceLimits();
  const busy = o.events("busy", { limit: 200 });
  assert.equal(busy.length, 20);
  assert.equal(busy[0].path, "/49", "新しい方を残す");
  assert.equal(o.events("quiet", { limit: 200 }).length, 5);

  // 1 件あたり 64 KB ほどのログを持つイベントを、上限（1 MB）を大きく超えるまで記録する
  const { o: big, db } = memoryObservability(t, { perSite: 10_000, maxBytes: 1024 * 1024 });
  for (let i = 0; i < 100; i++) {
    const inv = new Invocation(`s${i % 10}`, "r1", new Request("http://x/"), "/");
    for (let j = 0; j < 16; j++) inv.log("log", ["x".repeat(4000)]);
    big.record(inv, 200, 1);
  }
  big.enforceLimits();
  const pragma = (name: string) => Number((db.prepare(`PRAGMA ${name}`).get() as Record<string, number>)[name]);
  assert.ok((pragma("page_count") - pragma("freelist_count")) * pragma("page_size") <= 1024 * 1024);
  const left = (db.prepare("SELECT count(*) AS n FROM events").get() as { n: number }).n;
  assert.ok(left > 0 && left < 100, `${left}`);
});

test("以前の meta.sqlite に入っていたログは events.sqlite に移し、meta.sqlite からは消す", (t) => {
  const dir = tmpDir(t);
  const meta = openMetaDb(dir);
  meta.exec(`CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, site TEXT NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL, release TEXT,
    method TEXT NOT NULL, path TEXT NOT NULL, status INTEGER NOT NULL, outcome TEXT NOT NULL, duration_ms REAL NOT NULL, log_count INTEGER NOT NULL,
    error TEXT, detail TEXT NOT NULL)`);
  meta
    .prepare(
      "INSERT INTO events (site, ts, kind, method, path, status, outcome, duration_ms, log_count, detail) VALUES ('app', ?, 'asset', 'GET', '/', 200, 'ok', 1, 0, '{}')",
    )
    .run(Date.now());
  const db = openEventsDb(dir, meta);
  t.after(() => {
    db.close();
    meta.close();
  });
  assert.equal((db.prepare("SELECT count(*) AS n FROM events").get() as { n: number }).n, 1);
  assert.equal(meta.prepare("SELECT name FROM sqlite_master WHERE name = 'events'").get(), undefined);
});
