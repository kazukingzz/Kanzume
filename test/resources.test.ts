import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { ResourceMonitor, detectReader } from "../src/observability/resources.ts";
import { tmpDir } from "./helpers.ts";

function write(root: string, files: Record<string, string>) {
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }
}

test("cgroup v2 から上限と使用量を読み、page cache の解放できる分は除く", (t) => {
  const root = tmpDir(t);
  write(root, {
    "cgroup.controllers": "cpu memory",
    "cpu.max": "10000 100000\n",
    "cpu.stat": "usage_usec 5000000\nuser_usec 4000000\n",
    "memory.max": "536870912\n",
    "memory.current": "209715200\n",
    "memory.stat": "anon 100\ninactive_file 52428800\nactive_file 1\n",
  });
  const reader = detectReader(root);
  assert.equal(reader.source, "cgroup2");
  assert.equal(reader.cpuLimit(), 0.1);
  assert.equal(reader.cpuLimitRaw(), "cpu.max: 10000 100000");
  assert.equal(reader.memoryLimit(), 512 * 1024 * 1024);
  assert.equal(reader.memory(), 150 * 1024 * 1024);
  assert.equal(reader.cpuUsec(), 5_000_000);

  write(root, { "cpu.max": "max 100000\n", "memory.max": "max\n" });
  assert.equal(reader.cpuLimit(), null);
  assert.equal(reader.memoryLimit(), null);
});

test("cgroup v1 も読め、上限なしの巨大な値は null にする", (t) => {
  const root = tmpDir(t);
  write(root, {
    "memory/memory.usage_in_bytes": "104857600\n",
    "memory/memory.limit_in_bytes": "9223372036854771712\n",
    "memory/memory.stat": "total_inactive_file 4194304\n",
    "cpu,cpuacct/cpuacct.usage": "2000000000\n",
    "cpu,cpuacct/cpu.cfs_quota_us": "50000\n",
    "cpu,cpuacct/cpu.cfs_period_us": "100000\n",
  });
  const reader = detectReader(root);
  assert.equal(reader.source, "cgroup1");
  assert.equal(reader.cpuLimit(), 0.5);
  assert.equal(reader.cpuLimitRaw(), "cpu.cfs_quota_us: 50000 / cpu.cfs_period_us: 100000");
  assert.equal(reader.memoryLimit(), null);
  assert.equal(reader.memory(), 96 * 1024 * 1024);
  assert.equal(reader.cpuUsec(), 2_000_000);
});

test("cgroup がなければ Node プロセスの値にフォールバックする", (t) => {
  const reader = detectReader(tmpDir(t));
  assert.equal(reader.source, "process");
  assert.ok(reader.memory() > 0);
  assert.ok((reader.cpuLimit() ?? 0) >= 1);
});

test("CPU は前回との差分から使ったコア数を出し、古いサンプルは捨てる", (t) => {
  const root = tmpDir(t);
  write(root, {
    "cgroup.controllers": "cpu memory",
    "cpu.max": "10000 100000\n",
    "cpu.stat": "usage_usec 1000000\n",
    "memory.current": "1048576\n",
  });
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  t.after(() => (Date.now = realNow));
  const monitor = new ResourceMonitor({ root, intervalMs: 1000, keepMs: 3000 });
  t.after(() => monitor.close());

  now += 1000;
  write(root, { "cpu.stat": "usage_usec 1050000\n" });
  monitor.sample();
  const snap = monitor.snapshot();
  assert.equal(snap.source, "cgroup2");
  assert.deepEqual(snap.limits, { cpu: 0.1, cpuRaw: "cpu.max: 10000 100000", memory: null });
  assert.equal(snap.samples[0].cpu, null);
  assert.equal(snap.samples[1].cpu, 0.05);
  assert.equal(snap.samples[1].memory, 1048576);

  for (let i = 0; i < 5; i++) {
    now += 1000;
    monitor.sample();
  }
  assert.equal(monitor.snapshot().samples.length, 3);
});
