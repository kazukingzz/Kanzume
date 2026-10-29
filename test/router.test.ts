import assert from "node:assert/strict";
import { test } from "node:test";
import { runWorkerFirst } from "../src/router.ts";

test("run_worker_first は真偽値とパターン配列（! で除外）に従う", () => {
  assert.equal(runWorkerFirst(true, "/a"), true);
  assert.equal(runWorkerFirst(false, "/a"), false);
  assert.equal(runWorkerFirst(["/api/*"], "/api/users"), true);
  assert.equal(runWorkerFirst(["/api/*"], "/index.html"), false);
  assert.equal(runWorkerFirst(["/api/*", "!/api/docs/*"], "/api/docs/a"), false);
});
