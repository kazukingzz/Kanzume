import assert from "node:assert/strict";
import { test } from "node:test";
import { closeSiteDb, siteDb } from "../src/bindings/db.ts";
import { KVNamespace } from "../src/bindings/kv.ts";
import { tmpDir } from "./helpers.ts";

function kv(t: Parameters<typeof tmpDir>[0], namespace = "KV") {
  const dir = tmpDir(t);
  t.after(() => closeSiteDb(dir));
  return { dir, kv: new KVNamespace(siteDb(dir), namespace) };
}

test("put した値を text / json / arrayBuffer / stream で get できる", async (t) => {
  const { kv: ns } = kv(t);
  await ns.put("s", "hello");
  await ns.put("j", JSON.stringify({ a: 1 }));
  await ns.put("b", new Uint8Array([1, 2, 3]));
  assert.equal(await ns.get("s"), "hello");
  assert.equal(await ns.get("s", "text"), "hello");
  assert.deepEqual(await ns.get("j", "json"), { a: 1 });
  assert.deepEqual(await ns.get("j", { type: "json" }), { a: 1 });
  const buf = (await ns.get("b", "arrayBuffer")) as ArrayBuffer;
  assert.ok(buf instanceof ArrayBuffer);
  assert.deepEqual([...new Uint8Array(buf)], [1, 2, 3]);
  const stream = (await ns.get("s", "stream")) as ReadableStream;
  assert.equal(await new Response(stream).text(), "hello");
  assert.equal(await ns.get("missing"), null);
});

test("ReadableStream も値として put できる", async (t) => {
  const { kv: ns } = kv(t);
  await ns.put("k", new Response("streamed").body);
  assert.equal(await ns.get("k"), "streamed");
});

test("複数キーの get は Map を返す", async (t) => {
  const { kv: ns } = kv(t);
  await ns.put("a", "1");
  const m = (await ns.get(["a", "b"])) as Map<string, unknown>;
  assert.deepEqual([...m], [["a", "1"], ["b", null]]);
});

test("getWithMetadata で metadata が返る", async (t) => {
  const { kv: ns } = kv(t);
  await ns.put("k", "v", { metadata: { owner: "me" } });
  assert.deepEqual(await ns.getWithMetadata("k"), { value: "v", metadata: { owner: "me" }, cacheStatus: null });
  assert.deepEqual(await ns.getWithMetadata("none"), { value: null, metadata: null, cacheStatus: null });
});

test("delete で消える", async (t) => {
  const { kv: ns } = kv(t);
  await ns.put("k", "v");
  await ns.delete("k");
  assert.equal(await ns.get("k"), null);
});

test("期限切れの値は返らない", async (t) => {
  const { kv: ns } = kv(t);
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000_000_000 });
  await ns.put("k", "v", { expirationTtl: 60 });
  assert.equal(await ns.get("k"), "v");
  t.mock.timers.setTime(1_000_000_000_000 + 61_000);
  assert.equal(await ns.get("k"), null);
  const list = (await ns.list()) as { keys: unknown[] };
  assert.equal(list.keys.length, 0);
});

test("Cloudflare と同じく 60 秒未満の TTL や不正なキーは拒否する", async (t) => {
  const { kv: ns } = kv(t);
  await assert.rejects(ns.put("k", "v", { expirationTtl: 10 }), TypeError);
  await assert.rejects(ns.put("", "v"), TypeError);
  await assert.rejects(ns.put("..", "v"), TypeError);
  await assert.rejects(ns.put("x".repeat(513), "v"), TypeError);
});

test("list は prefix で絞り込み、cursor でページングできる", async (t) => {
  const { kv: ns } = kv(t);
  for (const k of ["user:1", "user:2", "user:3", "post:1"]) await ns.put(k, k, { metadata: { k } });
  const page1 = (await ns.list({ prefix: "user:", limit: 2 })) as { keys: { name: string }[]; list_complete: boolean; cursor: string };
  assert.deepEqual(page1.keys.map((k) => k.name), ["user:1", "user:2"]);
  assert.equal(page1.list_complete, false);
  const page2 = (await ns.list({ prefix: "user:", limit: 2, cursor: page1.cursor })) as { keys: { name: string; metadata: unknown }[]; list_complete: boolean };
  assert.deepEqual(page2.keys, [{ name: "user:3", metadata: { k: "user:3" } }]);
  assert.equal(page2.list_complete, true);
});

test("namespace（binding）ごとにデータが分かれる", async (t) => {
  const dir = tmpDir(t);
  t.after(() => closeSiteDb(dir));
  const a = new KVNamespace(siteDb(dir), "A");
  const b = new KVNamespace(siteDb(dir), "B");
  await a.put("k", "a");
  assert.equal(await b.get("k"), null);
});
