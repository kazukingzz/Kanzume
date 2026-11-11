import assert from "node:assert/strict";
import { test } from "node:test";
import { closeSiteDb, siteDb } from "../src/bindings/db.ts";
import { R2Bucket, R2ObjectBody } from "../src/bindings/r2.ts";
import { tmpDir } from "./helpers.ts";

function bucket(t: Parameters<typeof tmpDir>[0]) {
  const dir = tmpDir(t);
  t.after(() => closeSiteDb(dir));
  return new R2Bucket(siteDb(dir), dir, "files");
}

test("put したオブジェクトを get / head できる", async (t) => {
  const b = bucket(t);
  const put = await b.put("a/b.txt", "hello", {
    httpMetadata: { contentType: "text/plain" },
    customMetadata: { owner: "me" },
  });
  assert.equal(put?.key, "a/b.txt");
  assert.equal(put?.size, 5);
  assert.equal(put?.etag, "5d41402abc4b2a76b9719d911017c592");
  assert.equal(put?.httpEtag, '"5d41402abc4b2a76b9719d911017c592"');

  const obj = (await b.get("a/b.txt")) as R2ObjectBody;
  assert.ok(obj instanceof R2ObjectBody);
  assert.equal(await obj.text(), "hello");
  assert.equal(obj.bodyUsed, true);
  assert.deepEqual(obj.customMetadata, { owner: "me" });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  assert.equal(headers.get("content-type"), "text/plain");

  const head = await b.head("a/b.txt");
  assert.equal(head?.size, 5);
  assert.equal(await b.get("missing"), null);
  assert.equal(await b.head("missing"), null);
});

test("httpMetadata に Headers を渡せる", async (t) => {
  const b = bucket(t);
  await b.put("k", "v", { httpMetadata: new Headers({ "content-type": "image/png", "cache-control": "max-age=60" }) });
  const head = await b.head("k");
  assert.deepEqual(head?.httpMetadata, { contentType: "image/png", cacheControl: "max-age=60" });
});

test("ReadableStream を put でき、body をストリームで読める", async (t) => {
  const b = bucket(t);
  await b.put("k", new Response("streamed body").body);
  const obj = (await b.get("k")) as R2ObjectBody;
  assert.equal(await new Response(obj.body).text(), "streamed body");
});

test("range 指定で一部だけ読める", async (t) => {
  const b = bucket(t);
  await b.put("k", "0123456789");
  assert.equal(await ((await b.get("k", { range: { offset: 2, length: 3 } })) as R2ObjectBody).text(), "234");
  assert.equal(await ((await b.get("k", { range: { suffix: 2 } })) as R2ObjectBody).text(), "89");
  const obj = (await b.get("k", { range: new Headers({ range: "bytes=5-" }) })) as R2ObjectBody;
  assert.equal(await obj.text(), "56789");
  assert.deepEqual(obj.range, { offset: 5, length: 5 });
  assert.equal(await ((await b.get("k", { range: new Headers({ range: "bytes=8-100" }) })) as R2ObjectBody).text(), "89", "終わりがサイズを超えたら最後まで");
});

test("満たせない range はエラーにし、ファイルを開いたままにしない", async (t) => {
  const b = bucket(t);
  await b.put("k", "0123456789");
  for (const range of [new Headers({ range: "bytes=5-2" }), new Headers({ range: "bytes=10-" }), { offset: -5 }, { suffix: -1 }, { offset: 1, length: -2 }]) {
    await assert.rejects(b.get("k", { range }), RangeError, JSON.stringify(range instanceof Headers ? range.get("range") : range));
  }
  assert.equal(await ((await b.get("k")) as R2ObjectBody).text(), "0123456789");
});

test("onlyIf が満たされないと get は body なしの R2Object を返す", async (t) => {
  const b = bucket(t);
  const put = await b.put("k", "v");
  const miss = await b.get("k", { onlyIf: { etagDoesNotMatch: put!.etag } });
  assert.ok(miss && !(miss instanceof R2ObjectBody));
  const hit = await b.get("k", { onlyIf: new Headers({ "if-match": put!.httpEtag }) });
  assert.ok(hit instanceof R2ObjectBody);
});

test("onlyIf が満たされないと put は null を返し上書きしない", async (t) => {
  const b = bucket(t);
  await b.put("k", "v1");
  assert.equal(await b.put("k", "v2", { onlyIf: { etagMatches: "nope" } }), null);
  assert.equal(await ((await b.get("k")) as R2ObjectBody).text(), "v1");
});

test("上書きと delete（複数キー）ができる", async (t) => {
  const b = bucket(t);
  await b.put("a", "1");
  await b.put("a", "2");
  await b.put("b", "3");
  assert.equal(await ((await b.get("a")) as R2ObjectBody).text(), "2");
  await b.delete(["a", "b", "none"]);
  assert.equal(await b.head("a"), null);
  assert.equal(await b.head("b"), null);
});

test("list は prefix・delimiter・cursor に対応する", async (t) => {
  const b = bucket(t);
  for (const k of ["img/a.png", "img/b.png", "img/sub/c.png", "doc/x.md", "top.txt"]) await b.put(k, k);
  const all = (await b.list()) as { objects: { key: string }[]; truncated: boolean };
  assert.deepEqual(
    all.objects.map((o) => o.key),
    ["doc/x.md", "img/a.png", "img/b.png", "img/sub/c.png", "top.txt"],
  );

  const dirs = (await b.list({ delimiter: "/" })) as { objects: { key: string }[]; delimitedPrefixes: string[] };
  assert.deepEqual(
    dirs.objects.map((o) => o.key),
    ["top.txt"],
  );
  assert.deepEqual(dirs.delimitedPrefixes, ["doc/", "img/"]);

  const img = (await b.list({ prefix: "img/", delimiter: "/" })) as { objects: { key: string }[]; delimitedPrefixes: string[] };
  assert.deepEqual(
    img.objects.map((o) => o.key),
    ["img/a.png", "img/b.png"],
  );
  assert.deepEqual(img.delimitedPrefixes, ["img/sub/"]);

  const p1 = (await b.list({ limit: 2 })) as { objects: { key: string }[]; truncated: boolean; cursor: string };
  assert.equal(p1.truncated, true);
  const p2 = (await b.list({ limit: 10, cursor: p1.cursor })) as { objects: { key: string }[]; truncated: boolean };
  assert.deepEqual(
    p2.objects.map((o) => o.key),
    ["img/b.png", "img/sub/c.png", "top.txt"],
  );
  assert.equal(p2.truncated, false);
});

test("DB の version やシンボリックリンクで、バケットの外のファイルを読ませたり消させたりしない", async (t) => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const dir = tmpDir(t);
  t.after(() => closeSiteDb(dir));
  const db = siteDb(dir);
  const b = new R2Bucket(db, dir, "files");
  const secret = path.join(dir, "secret.txt");
  fs.writeFileSync(secret, "secret");

  // Worker の子プロセスは DB を書き換えられる。version に ../ を入れられても外を読まない・消さない
  await b.put("k", "v");
  db.prepare("UPDATE r2 SET version = ? WHERE key = ?").run("../../secret.txt", "k");
  await assert.rejects(b.get("k"), /不正なファイル名/);
  await b.delete("k");
  assert.equal(fs.readFileSync(secret, "utf8"), "secret", "外のファイルは消さない");

  // オブジェクトのファイルがシンボリックリンクなら開かない
  const put = await b.put("link", "v");
  const row = db.prepare("SELECT version FROM r2 WHERE key = ?").get("link") as { version: string };
  const file = path.join(dir, "data", "r2", "files", row.version);
  fs.rmSync(file);
  fs.symlinkSync(secret, file);
  assert.ok(put);
  await assert.rejects(b.get("link"));

  // バケットのディレクトリがよそを指すシンボリックリンクなら使わない
  const elsewhere = tmpDir(t);
  fs.rmSync(path.join(dir, "data", "r2", "files"), { recursive: true });
  fs.symlinkSync(elsewhere, path.join(dir, "data", "r2", "files"));
  await assert.rejects(b.put("x", "y"), /ディレクトリが不正/);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});
