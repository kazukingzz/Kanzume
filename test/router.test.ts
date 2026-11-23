import assert from "node:assert/strict";
import { test } from "node:test";
import { globMatch, runWorkerFirst } from "../src/router.ts";

test("run_worker_first は真偽値とパターン配列（! で除外）に従う", () => {
  assert.equal(runWorkerFirst(true, "/a"), true);
  assert.equal(runWorkerFirst(false, "/a"), false);
  assert.equal(runWorkerFirst(["/api/*"], "/api/users"), true);
  assert.equal(runWorkerFirst(["/api/*"], "/index.html"), false);
  assert.equal(runWorkerFirst(["/api/*", "!/api/docs/*"], "/api/docs/a"), false);
});

test("run_worker_first の * は / をまたぐ 0 文字以上に合い、ほかの文字はそのまま比べる", () => {
  assert.equal(globMatch("/api/*", "/api/a/b"), true);
  assert.equal(globMatch("/api/*", "/api/"), true);
  assert.equal(globMatch("/api/*", "/api"), false);
  assert.equal(globMatch("*", ""), true);
  assert.equal(globMatch("/a*b*c", "/aXbYbZc"), true);
  assert.equal(globMatch("/a*b*c", "/aXcYb"), false);
  assert.equal(globMatch("/a*a", "/a"), false, "前と後ろの部分が重ならない");
  assert.equal(globMatch("/x.(y)?", "/x.(y)?"), true, "正規表現の記号もそのまま比べる");
  assert.equal(globMatch("/x.y", "/xzy"), false);
});

test("run_worker_first に * が並ぶパターンと長いパスを渡しても、すぐに終わる", () => {
  const started = performance.now();
  const path = `/${"a".repeat(2048)}`;
  const rule = Array.from({ length: 100 }, (_, i) => `/*a*a*a*a*a*a*a*a*a*a*${"a".repeat(i % 50)}*b`);
  assert.equal(runWorkerFirst(rule, path), false);
  assert.ok(performance.now() - started < 1000, `${performance.now() - started}ms`);
});
