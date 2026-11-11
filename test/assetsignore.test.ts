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
