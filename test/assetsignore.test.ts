import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAssetsIgnore as fromAction } from "../action/assetsignore.mjs";
import { parseAssetsIgnore } from "../src/deploy/assetsignore.ts";

const IGNORE = `
# コメント
_worker.js
*.map
/secret.txt
drafts/
docs/**/*.tmp
!keep.map
`;

const CASES: [string, boolean][] = [
  ["index.html", false],
  ["_worker.js", true],
  ["_worker.js/index.js", true],
  ["nested/_worker.js", true],
  ["app.js.map", true],
  ["js/app.js.map", true],
  ["keep.map", false],
  ["secret.txt", true],
  ["sub/secret.txt", false],
  ["drafts/a.html", true],
  ["blog/drafts/a.html", true],
  ["drafts", false],
  ["docs/a.tmp", true],
  ["docs/x/y/a.tmp", true],
  ["docs/a.html", false],
];

test(".assetsignore は gitignore と同じ書き方で、外したディレクトリの中も外す", () => {
  const ignored = parseAssetsIgnore(IGNORE);
  for (const [p, expected] of CASES) assert.equal(ignored(p), expected, p);
});

test("Action の .assetsignore の読み方は、サーバーと同じ", () => {
  const a = parseAssetsIgnore(IGNORE);
  const b = fromAction(IGNORE);
  for (const [p] of CASES) assert.equal(b(p), a(p), p);
  assert.equal(parseAssetsIgnore("")("anything"), false);
});

test(".assetsignore の * が並ぶパターンや長い空白でも、すぐに終わる", () => {
  const started = performance.now();
  const ignored = parseAssetsIgnore(`${"*a".repeat(60)}b\n**/${"*x".repeat(60)}y/**\nz${" ".repeat(200_000)}\n`);
  for (let i = 0; i < 200; i++) assert.equal(ignored(`${"a".repeat(250)}/${"x".repeat(250)}/f${i}`), false);
  assert.equal(ignored("z"), true);
  assert.throws(() => parseAssetsIgnore(`${" ".repeat(200_000)}x`), /256 文字以内/);
  assert.ok(performance.now() - started < 2000, `${performance.now() - started}ms`);
});

test(".assetsignore のパターンが多すぎる・長すぎるときはエラーにする（サーバーと Action で同じ）", () => {
  for (const parse of [parseAssetsIgnore, fromAction]) {
    assert.doesNotThrow(() => parse(Array.from({ length: 200 }, (_, i) => `f${i}`).join("\n")));
    assert.throws(() => parse(Array.from({ length: 201 }, (_, i) => `f${i}`).join("\n")), /200 個以内/);
    assert.throws(() => parse("a".repeat(257)), /256 文字以内/);
    assert.doesNotThrow(() => parse(`# ${"a".repeat(1000)}\n`), "コメントは数えない");
  }
});

test(".assetsignore の \\ のあとの空白は残し、ほかの末尾の空白は消す", () => {
  assert.equal(parseAssetsIgnore("a.txt   \t")("a.txt"), true);
  assert.equal(parseAssetsIgnore("a\\ \n")("a "), true);
  assert.equal(parseAssetsIgnore("a\\ \n")("a"), false);
});
