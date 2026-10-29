import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { Store } from "../src/store.ts";
import { manifest, tmpDir } from "./helpers.ts";

const file = (p: string, d: string) => ({ path: p, data: Buffer.from(d) });

test("activate した版が current になり、再起動後も読み込める", async (t) => {
  const dataDir = tmpDir(t);
  const store = new Store(dataDir);
  await store.init();
  const r1 = await store.createRelease(manifest(), [file("worker/index.js", "1")]);
  assert.equal(store.get(), undefined);
  await store.activate(r1);
  const r2 = await store.createRelease(manifest(), [file("worker/index.js", "2")]);
  assert.equal(store.get()?.id, r1.id);
  await store.activate(r2);
  assert.equal(store.get()?.id, r2.id);

  const reopened = new Store(dataDir);
  await reopened.init();
  assert.equal(reopened.get()?.id, r2.id);
  assert.equal(fs.readFileSync(path.join(reopened.get()!.dir, "worker/index.js"), "utf8"), "2");
});

test("古い版は 3 つまで残して消す", async (t) => {
  const store = new Store(tmpDir(t));
  await store.init();
  for (let i = 0; i < 5; i++) {
    await store.activate(await store.createRelease(manifest(), [file("worker/index.js", String(i))]));
  }
  const releases = fs.readdirSync(path.join(store.siteDir, "releases"));
  assert.equal(releases.length, 3);
  assert.ok(releases.includes(store.get()!.id));
});

test("discard した版は残らず、current も変わらない", async (t) => {
  const store = new Store(tmpDir(t));
  await store.init();
  const r1 = await store.createRelease(manifest(), [file("worker/index.js", "1")]);
  await store.activate(r1);
  const r2 = await store.createRelease(manifest(), [file("worker/index.js", "2")]);
  await store.discard(r2);
  assert.equal(fs.existsSync(r2.dir), false);
  assert.equal(store.get()?.id, r1.id);
});

test("remove でサイトのディレクトリごと消え、また新しくデプロイできる", async (t) => {
  const store = new Store(tmpDir(t));
  await store.init();
  await store.activate(await store.createRelease(manifest(), [file("worker/index.js", "1")]));
  fs.writeFileSync(path.join(store.siteDir, "data.sqlite"), "kv");
  await store.remove();
  assert.equal(store.get(), undefined);
  assert.equal(fs.existsSync(path.join(store.siteDir, "data.sqlite")), false);
  await store.activate(await store.createRelease(manifest(), [file("worker/index.js", "2")]));
  assert.ok(store.get());
});
