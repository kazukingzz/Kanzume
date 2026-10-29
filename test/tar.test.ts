import assert from "node:assert/strict";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { readTar, TarError } from "../src/deploy/tar.ts";
import { rawTar, rawTarEntry, tarGz } from "./helpers.ts";

test("システムの tar で作った tar.gz を読める（長いパス・日本語のファイル名を含む）", (t) => {
  const long = `assets/${"deep/".repeat(30)}file.txt`;
  const files = readTar(
    gunzipSync(
      tarGz(t, {
        "wrangler.jsonc": "{}",
        "worker/index.js": "export default {}",
        [long]: "long",
        "assets/日本語.html": "こんにちは",
      }),
    ),
  );
  const byPath = Object.fromEntries(files.map((f) => [f.path, f.data.toString()]));
  assert.equal(byPath["wrangler.jsonc"], "{}");
  assert.equal(byPath["worker/index.js"], "export default {}");
  assert.equal(byPath[long], "long");
  assert.equal(byPath["assets/日本語.html"], "こんにちは");
});

test("ディレクトリを抜けるパスは拒否する", () => {
  assert.throws(() => readTar(rawTar([rawTarEntry("../evil.txt", Buffer.from("x"))])), TarError);
  assert.throws(() => readTar(rawTar([rawTarEntry("assets/../../evil.txt", Buffer.from("x"))])), TarError);
  assert.throws(() => readTar(rawTar([rawTarEntry("/etc/passwd", Buffer.from("x"))])), TarError);
});

test("シンボリックリンクとハードリンクは拒否する", () => {
  assert.throws(() => readTar(rawTar([rawTarEntry("assets/link", Buffer.alloc(0), "2", "/etc/passwd")])), TarError);
  assert.throws(() => readTar(rawTar([rawTarEntry("assets/link", Buffer.alloc(0), "1", "wrangler.json")])), TarError);
});

test("壊れた tar は拒否する", () => {
  const entry = rawTarEntry("a.txt", Buffer.from("hello"));
  entry[0] ^= 0xff;
  assert.throws(() => readTar(rawTar([entry])), TarError);
  assert.throws(() => readTar(rawTarEntry("a.txt", Buffer.from("hello")).subarray(0, 515)), TarError);
});
