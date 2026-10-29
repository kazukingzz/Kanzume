import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigError, parseWranglerConfig, stripJsonc, toManifest } from "../src/deploy/wrangler.ts";

test("JSONC のコメントと末尾カンマを読める（文字列中の // は残る）", () => {
  const text = `{
    // comment
    "url": "https://example.com/a//b", /* block */
    "list": [1, 2,],
  }`;
  assert.deepEqual(JSON.parse(stripJsonc(text)), { url: "https://example.com/a//b", list: [1, 2] });
});

test("wrangler.toml を読める", () => {
  const raw = parseWranglerConfig(
    "wrangler.toml",
    `name = "app"
main = "src/index.ts"
compatibility_flags = ["nodejs_compat"]
[vars]
A = "1"
[[kv_namespaces]]
binding = "KV"
id = "abc"
[[r2_buckets]]
binding = "BUCKET"
bucket_name = "files"
[assets]
directory = "./public"
not_found_handling = "single-page-application"
`,
  );
  const m = toManifest(raw, true);
  assert.equal(m.name, "app");
  assert.equal(m.main, "index.cjs");
  assert.deepEqual(m.compatibilityFlags, ["nodejs_compat"]);
  assert.deepEqual(m.vars, { A: "1" });
  assert.deepEqual(m.kvNamespaces, [{ binding: "KV" }]);
  assert.deepEqual(m.r2Buckets, [{ binding: "BUCKET", bucketName: "files" }]);
  assert.equal(m.assets?.notFoundHandling, "single-page-application");
  assert.equal(m.assets?.htmlHandling, "auto-trailing-slash");
});

test("wrangler の設定に KV の id が書いてあってもそのまま受け付ける", () => {
  const m = toManifest({ name: "a", main: "src/worker.ts", kv_namespaces: [{ binding: "KV", id: "0123", preview_id: "x" }] }, true);
  assert.equal(m.main, "worker.cjs");
  assert.deepEqual(m.kvNamespaces, [{ binding: "KV" }]);
});

test("静的アセットだけのプロジェクトは main なしで受け付ける", () => {
  const m = toManifest({ name: "site", assets: { directory: "dist" } }, false);
  assert.equal(m.main, null);
  assert.equal(m.assets?.binding, null);
});

test("不正な設定は ConfigError になる", () => {
  assert.throws(() => toManifest({ name: "Bad_Name", main: "a.ts" }, true), ConfigError);
  assert.throws(() => toManifest({ name: "_admin", main: "a.ts" }, true), ConfigError);
  assert.throws(() => toManifest({ name: "a" }, false), ConfigError);
  assert.throws(() => toManifest({ name: "a", main: "a.ts" }, false), ConfigError);
  assert.throws(() => toManifest({ name: "a", main: "a.ts", kv_namespaces: [{ binding: "bad-name" }] }, true), ConfigError);
  assert.throws(() => toManifest({ name: "a", assets: { not_found_handling: "nope" } }, false), ConfigError);
  assert.throws(() => parseWranglerConfig("wrangler.json", "{"), ConfigError);
});
