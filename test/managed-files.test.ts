import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { fakeCredential, startApp } from "./fixtures.ts";
import { tarGz, toCjs } from "./helpers.ts";
import {
  normalizeRobots,
  normalizeSecurityTxt,
  normalizeSiteManagedFiles,
  renderRobots,
  renderSecurityTxt,
  resolveManagedFile,
  TRAINING_CRAWLERS,
} from "../src/managed-files.ts";
import { UserFacingError } from "../src/errors.ts";

test("robots.txt: 3 つの方針から Content-Signal を作り、学習を断るときだけ学習用クローラーを Disallow にする", () => {
  const blocked = renderRobots(
    normalizeRobots({ enabled: true, search: "allow", agent: "allow", training: "block", extra: "Sitemap: https://example.com/sitemap.xml" }),
  );
  assert.match(blocked, /^User-agent: \*\nContent-Signal: search=yes, ai-input=yes, ai-train=no\nAllow: \/$/m);
  for (const bot of TRAINING_CRAWLERS) assert.match(blocked, new RegExp(`^User-agent: ${bot}\\nDisallow: /$`, "m"));
  assert.match(blocked, /\nSitemap: https:\/\/example\.com\/sitemap\.xml\n$/);

  const open = renderRobots(normalizeRobots({ enabled: true, search: "block", agent: "block", training: "allow" }));
  assert.match(open, /Content-Signal: search=no, ai-input=no, ai-train=yes/);
  assert.doesNotMatch(open, /Disallow/);
  // コメント以外の行は、robots.txt の書き方（名前: 値）になっている
  for (const l of blocked.split("\n")) assert.match(l, /^(#.*|[A-Za-z-]+: .+|)$/, l);
});

test("robots.txt: 知らない値は既定にし、大きすぎる・制御文字の入った追加のルールは断る", () => {
  assert.deepEqual(normalizeRobots({ training: "nope" }), { enabled: false, search: "allow", agent: "allow", training: "block", extra: "" });
  assert.equal(normalizeRobots({ extra: "Disallow: /a\r\nDisallow: /b\r\n" }).extra, "Disallow: /a\nDisallow: /b");
  assert.throws(() => normalizeRobots({ extra: "x".repeat(9000) }), UserFacingError);
  assert.throws(() => normalizeRobots({ extra: "a\u0000b" }), UserFacingError);
  assert.throws(() => normalizeRobots("x"), UserFacingError);
});

test("security.txt: RFC 9116 の形で出し、必須の欄・https 以外・行の差し込みを断る", () => {
  const config = normalizeSecurityTxt({
    enabled: true,
    contact: ["mailto:security@example.com", " https://example.com/report ", ""],
    expires: "2030-01-02T03:04:05Z",
    policy: "https://example.com/policy",
    preferredLanguages: "ja, en",
  });
  assert.equal(
    renderSecurityTxt(config),
    "Contact: mailto:security@example.com\nContact: https://example.com/report\nExpires: 2030-01-02T03:04:05.000Z\nPreferred-Languages: ja, en\nPolicy: https://example.com/policy\n",
  );
  const base = { enabled: true, contact: ["mailto:a@example.com"], expires: "2030-01-01" };
  for (const bad of [
    { ...base, contact: [] },
    { ...base, expires: "" },
    { ...base, expires: "いつか" },
    { ...base, contact: ["a@example.com"] },
    { ...base, contact: ["http://example.com/"] },
    { ...base, policy: "http://example.com/policy" },
    { ...base, policy: "https://example.com/\nContact: mailto:evil@example.com" },
    { ...base, contact: ["mailto:a@example.com\nPolicy: https://evil.example"] },
    { ...base, preferredLanguages: "日本語" },
    { ...base, contact: Array.from({ length: 11 }, (_, i) => `mailto:a${i}@example.com`) },
  ]) {
    assert.throws(() => normalizeSecurityTxt(bad), UserFacingError, JSON.stringify(bad));
  }
  // 無効のままなら、途中まで入力したものも保存できる
  assert.equal(normalizeSecurityTxt({ enabled: false, contact: [] }).enabled, false);
});

test("サイトの上書き: 既定に従う・このサイトだけ変える・返さない", () => {
  const global = { robots: normalizeRobots({ enabled: true }) };
  assert.match(resolveManagedFile("robots", global, undefined) ?? "", /ai-train=no/);
  assert.equal(resolveManagedFile("robots", global, { robots: { mode: "off" } }), null);
  const custom = normalizeSiteManagedFiles({ robots: { mode: "custom", config: { enabled: true, training: "allow" } } });
  assert.match(resolveManagedFile("robots", global, custom) ?? "", /ai-train=yes/);
  assert.equal(resolveManagedFile("robots", {}, undefined), null, "全体の既定がなければ返さない");
  assert.equal(resolveManagedFile("securityTxt", global, undefined), null);
  assert.deepEqual(normalizeSiteManagedFiles({ robots: { mode: "default" } }, custom), {}, "既定に従うなら、上書きを消す");
  assert.throws(() => normalizeSiteManagedFiles({ robots: { mode: "x" } }), UserFacingError);
});

const staticSite = (t: TestContext, name: string, files: Record<string, string>) =>
  tarGz(t, {
    "wrangler.jsonc": JSON.stringify({ name, assets: { directory: "public" } }),
    ...Object.fromEntries(Object.entries(files).map(([p, d]) => [`assets/${p}`, d])),
  });

test("設定が有効なら、robots.txt・security.txt のないサイトに Kanzume が返す。自前のファイルがあればそれを返す", async (t) => {
  const app = await startApp(t);
  const admin = app.api(await app.adminCookie());
  await app.deploy(staticSite(t, "plain", { "index.html": "plain" }));
  await app.deploy(staticSite(t, "own", { "index.html": "own", "robots.txt": "User-agent: *\nDisallow: /private\n" }));
  const get = (site: string, p: string, init: RequestInit = {}) => app.site(`${site}.localhost`, p, init);

  // 何も設定していなければ、今までどおり
  assert.equal((await get("plain", "/robots.txt")).status, 404);
  assert.equal((await get("plain", "/.well-known/security.txt")).status, 404);

  const saved = await admin("/managed-files", "PUT", { robots: { enabled: true, search: "allow", agent: "allow", training: "block", extra: "" } });
  assert.equal(saved.status, 200, await saved.clone().text());
  assert.match(((await saved.json()) as { preview: { robots: string } }).preview.robots, /ai-train=no/);

  const robots = await get("plain", "/robots.txt");
  assert.equal(robots.status, 200);
  assert.match(robots.headers.get("content-type") ?? "", /^text\/plain/);
  assert.match(await robots.text(), /Content-Signal: search=yes, ai-input=yes, ai-train=no[\s\S]*User-agent: GPTBot\nDisallow: \//);
  const head = await get("plain", "/robots.txt", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal((await get("plain", "/robots.txt", { method: "POST" })).status, 404, "GET と HEAD だけ");
  assert.equal(await (await get("plain", "/")).text(), "plain", "ほかのパスは変わらない");
  assert.equal(await (await get("own", "/robots.txt")).text(), "User-agent: *\nDisallow: /private\n", "自前のファイルがあればそれを返す");

  // サイトごとの上書き: 返さない → このサイトだけ変える → 既定に戻す。変えたらすぐ反映される
  const view = (await (await admin("/sites/plain/managed-files")).json()) as Record<string, { mode: string; ownFile: boolean; content: string | null }>;
  assert.equal(view.robots.mode, "default");
  assert.equal(view.robots.ownFile, false);
  assert.match(view.robots.content ?? "", /ai-train=no/);
  assert.equal(((await (await admin("/sites/own/managed-files")).json()) as typeof view).robots.ownFile, true);

  assert.equal((await admin("/sites/plain/managed-files", "PUT", { robots: { mode: "off" } })).status, 200);
  assert.equal((await get("plain", "/robots.txt")).status, 404);
  assert.equal((await admin("/sites/plain/managed-files", "PUT", { robots: { mode: "custom", config: { enabled: true, training: "allow" } } })).status, 200);
  assert.match(await (await get("plain", "/robots.txt")).text(), /ai-train=yes/);
  assert.equal((await admin("/sites/plain/managed-files", "PUT", { robots: { mode: "default" } })).status, 200);
  assert.match(await (await get("plain", "/robots.txt")).text(), /ai-train=no/);
  assert.equal(app.sites.settings("plain").managedFiles, undefined, "既定に従うなら、サイトの設定には残さない");

  // security.txt
  const bad = await admin("/managed-files", "PUT", { securityTxt: { enabled: true, contact: [], expires: "2030-01-01" } });
  assert.equal(bad.status, 400);
  assert.match(((await bad.json()) as { error: string }).error, /Contact/);
  const sec = { enabled: true, contact: ["mailto:security@example.com"], expires: "2030-01-01T00:00:00Z", policy: "https://example.com/policy" };
  assert.equal((await admin("/managed-files", "PUT", { securityTxt: sec })).status, 200);
  assert.equal(
    await (await get("plain", "/.well-known/security.txt")).text(),
    "Contact: mailto:security@example.com\nExpires: 2030-01-01T00:00:00.000Z\nPolicy: https://example.com/policy\n",
  );
  assert.match(await (await get("plain", "/robots.txt")).text(), /ai-train=no/, "security.txt だけを保存しても、robots.txt の設定は残る");
  assert.equal((await admin("/managed-files", "PUT", { securityTxt: null })).status, 200);
  assert.equal((await get("plain", "/.well-known/security.txt")).status, 404, "削除したら返さない");

  // 保存する前のプレビュー（確かめ方は保存と同じ）
  const preview = await admin("/managed-files/preview", "POST", { kind: "robots", config: { enabled: true, training: "allow" } });
  assert.match(((await preview.json()) as { content: string }).content, /ai-train=yes/);
  assert.equal((await admin("/managed-files/preview", "POST", { kind: "securityTxt", config: { enabled: true } })).status, 400);

  // 再起動しても残る
  await app.state.flush();
  const { AdminState } = await import("../src/admin/state.ts");
  const reloaded = new AdminState(app.dataDir);
  await reloaded.init();
  assert.equal(reloaded.managedFiles.robots?.enabled, true);
});

test("Worker 付きのサイトでも、有効なら Worker を起動せずに返す。無効なら Worker が返す", async (t) => {
  const app = await startApp(t);
  const admin = app.api(await app.adminCookie());
  const worker = tarGz(t, {
    "wrangler.jsonc": JSON.stringify({ name: "api", main: "src/index.ts", compatibility_date: "2026-10-01" }),
    ...toCjs(t, { "worker/index.js": `export default { fetch(r) { return new Response("worker:" + new URL(r.url).pathname); } }` }),
  });
  assert.equal((await app.deploy(worker)).status, 200);
  app.runtime.evict();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(app.runtime.size, 0);

  await admin("/managed-files", "PUT", { robots: { enabled: true } });
  assert.match(await (await app.site("api.localhost", "/robots.txt")).text(), /Content-Signal/);
  assert.equal(app.runtime.size, 0, "Worker は起動していない");

  await admin("/sites/api/managed-files", "PUT", { robots: { mode: "off" } });
  assert.equal(await (await app.site("api.localhost", "/robots.txt")).text(), "worker:/robots.txt", "このサイトで返さないなら、Worker に任せる");
});

test("メンバーは自分のサイトの上書きは変えられるが、全体の既定とほかのサイトは変えられない", async (t) => {
  const app = await startApp(t);
  await app.adminCookie();
  for (const name of ["blog", "shop"]) await app.sites.ensure(name);
  const user = await app.state.createUser("メンバー", "member", ["blog"]);
  await app.state.addCredential(fakeCredential(`cred-${user.id}`, user.id));
  const { cookieFor } = await import("./fixtures.ts");
  const member = app.api(cookieFor(await app.state.createSession(user.id)));
  assert.equal((await member("/managed-files")).status, 403);
  assert.equal((await member("/managed-files", "PUT", { robots: { enabled: true } })).status, 403);
  assert.equal((await member("/sites/shop/managed-files")).status, 403);
  assert.equal((await member("/sites/shop/managed-files", "PUT", { robots: { mode: "off" } })).status, 403);
  assert.equal((await member("/sites/blog/managed-files", "PUT", { robots: { mode: "custom", config: { enabled: true } } })).status, 200);
  assert.equal((await app.api(null)("/sites/blog/managed-files")).status, 401);
  assert.equal(app.sites.settings("blog").managedFiles?.robots?.mode, "custom");
});
