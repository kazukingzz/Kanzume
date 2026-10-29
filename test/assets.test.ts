import assert from "node:assert/strict";
import { test } from "node:test";
import { AssetsBinding, matchAsset, serveAssets } from "../src/bindings/assets.ts";
import type { Manifest } from "../src/store.ts";
import { manifest, release } from "./helpers.ts";

const files = {
  "assets/index.html": "<h1>home</h1>",
  "assets/about.html": "about",
  "assets/blog/index.html": "blog",
  "assets/blog/404.html": "blog 404",
  "assets/404.html": "root 404",
  "assets/app.js": "console.log(1)",
};

function withAssets(assets: Partial<NonNullable<Manifest["assets"]>> = {}) {
  return manifest({
    main: null,
    assets: { binding: null, htmlHandling: "auto-trailing-slash", notFoundHandling: "none", runWorkerFirst: false, ...assets },
  });
}

const req = (p: string, init?: RequestInit) => new Request(`http://x${p}`, init);

test("auto-trailing-slash で Workers Static Assets と同じように HTML を解決する", async (t) => {
  const { release: r } = await release(t, withAssets(), files);
  assert.equal(await (await matchAsset(r, req("/")))!.text(), "<h1>home</h1>");
  assert.equal(await (await matchAsset(r, req("/about")))!.text(), "about");
  assert.equal(await (await matchAsset(r, req("/blog/")))!.text(), "blog");

  const toSlash = (await matchAsset(r, req("/blog?x=1")))!;
  assert.equal(toSlash.status, 307);
  assert.equal(toSlash.headers.get("location"), "/blog/?x=1");
  assert.equal((await matchAsset(r, req("/about.html")))!.headers.get("location"), "/about");
  assert.equal((await matchAsset(r, req("/about/")))!.headers.get("location"), "/about");
  assert.equal((await matchAsset(r, req("/index.html")))!.headers.get("location"), "/");
  assert.equal(await matchAsset(r, req("/nope")), null);
});

test("Content-Type と ETag を付け、If-None-Match で 304 を返す", async (t) => {
  const { release: r } = await release(t, withAssets(), files);
  const res = (await matchAsset(r, req("/app.js")))!;
  assert.equal(res.headers.get("content-type"), "text/javascript; charset=utf-8");
  const etag = res.headers.get("etag")!;
  const cached = (await matchAsset(r, req("/app.js", { headers: { "if-none-match": etag } })))!;
  assert.equal(cached.status, 304);
});

test("パストラバーサルではアセットの外を読めない", async (t) => {
  const { release: r } = await release(t, withAssets(), files);
  assert.equal(await matchAsset(r, req("/..%2f_manifest.json")), null);
  assert.equal(await matchAsset(r, req("/%2e%2e/_manifest.json")), null);
});

test("not_found_handling: single-page-application は index.html を返す", async (t) => {
  const { release: r } = await release(t, withAssets({ notFoundHandling: "single-page-application" }), files);
  const res = await serveAssets(r, req("/some/route"));
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "<h1>home</h1>");
});

test("not_found_handling: 404-page は最も近い 404.html を 404 で返す", async (t) => {
  const { release: r } = await release(t, withAssets({ notFoundHandling: "404-page" }), files);
  const blog = await serveAssets(r, req("/blog/missing"));
  assert.equal(blog.status, 404);
  assert.equal(await blog.text(), "blog 404");
  assert.equal(await (await serveAssets(r, req("/x/y"))).text(), "root 404");
});

test("html_handling: none は完全一致のみ", async (t) => {
  const { release: r } = await release(t, withAssets({ htmlHandling: "none" }), files);
  assert.equal(await matchAsset(r, req("/about")), null);
  assert.equal(await (await matchAsset(r, req("/about.html")))!.text(), "about");
});

test("env.ASSETS.fetch は URL 文字列も受け付ける", async (t) => {
  const { release: r } = await release(t, withAssets(), files);
  const assets = new AssetsBinding(r);
  assert.equal(await (await assets.fetch("http://example.com/about")).text(), "about");
  assert.equal((await assets.fetch(req("/nope"))).status, 404);
});
