import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { AdminState } from "../src/admin/state.ts";
import { ServerLog, readServerLog, serverLogFile } from "../src/observability/server-log.ts";
import { startApp } from "./fixtures.ts";
import { tmpDir } from "./helpers.ts";

test("open するまでの行はためておき、open したらためた分から順に書く", (t) => {
  const dataDir = tmpDir(t);
  const log = new ServerLog();
  log.write("log", "起動前");
  assert.equal(fs.existsSync(serverLogFile(dataDir)), false);
  log.open(dataDir);
  log.write("error", "起動後\n2 行目");
  const { lines } = readServerLog(dataDir);
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^\d{4}-\d\d-\d\dT\S+ LOG {3}起動前$/);
  assert.match(lines[1], / ERROR 起動後$/);
  assert.equal(lines[2], "    2 行目");
});

test("上限を超えたら 1 世代前に回し、読むときは 2 世代をまたいで新しい方から返す", (t) => {
  const dataDir = tmpDir(t);
  const log = new ServerLog(200);
  log.open(dataDir);
  for (let i = 0; i < 10; i++) log.write("info", `line ${i}`);
  assert.ok(fs.statSync(serverLogFile(dataDir)).size <= 200);
  assert.ok(fs.existsSync(`${serverLogFile(dataDir)}.1`));
  const { lines } = readServerLog(dataDir);
  assert.match(lines.at(-1) as string, /line 9$/);
  assert.ok(lines.length > 3);
  assert.deepEqual(readServerLog(dataDir, 2).lines, lines.slice(-2));
});

test("1 秒あたりの行数を超えた分は書かずに「N 行を省略」とまとめ、長すぎる行は切る。落ちる直前の例外は必ず書く", (t) => {
  const dataDir = tmpDir(t);
  const log = new ServerLog(1024 * 1024, 3);
  log.open(dataDir);
  const t0 = 1_800_000_000_000;
  for (let i = 0; i < 1000; i++) log.write("log", `flood ${i}`, false, t0 + 10);
  log.write("error", "crash", true, t0 + 20);
  log.write("log", "x".repeat(100_000), false, t0 + 1000);
  const { lines } = readServerLog(dataDir);
  assert.deepEqual(
    lines.map((l) => l.replace(/^\S+ /, "").slice(0, 60)),
    [
      "LOG   flood 0",
      "LOG   flood 1",
      "LOG   flood 2",
      "ERROR crash",
      "WARN  [kanzume] ログが多すぎるため 997 行を省略しました（1 秒あたり 3 行まで）",
      `LOG   ${"x".repeat(54)}`,
    ],
  );
  assert.ok(lines[5].length < 9000);
  assert.match(lines[5], /…（91808 文字を省略）$/);
});

test("ログがなければ空を返す", (t) => {
  assert.deepEqual(readServerLog(tmpDir(t)), { lines: [], bytes: 0 });
});

test("管理者は API で本体のログを読め、ログインしていなければ読めない", async (t) => {
  const dataDir = tmpDir(t);
  const state = new AdminState(dataDir);
  await state.init();
  const cookie = `kanzume_session=${await state.createSession()}`;
  const log = new ServerLog();
  log.open(dataDir);
  log.write("warn", "見えるログ");

  const app = await startApp(t, { KANZUME_DATA_DIR: dataDir });
  const res = await fetch(`${app.base}/_admin/kanzume/api/server-log`, { headers: { cookie } });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { lines: string[] };
  assert.match(body.lines.at(-1) as string, / WARN {2}見えるログ$/);
  assert.equal((await fetch(`${app.base}/_admin/kanzume/api/server-log`)).status, 401);
});
