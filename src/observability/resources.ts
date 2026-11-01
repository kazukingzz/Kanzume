import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// コンテナの CPU / メモリを cgroup から読む。os.totalmem() や os.cpus() はホストの値を返すので使わない
export type ResourceSource = "cgroup2" | "cgroup1" | "process";

export interface ResourceSample {
  t: number;
  /** 使っている CPU（コア数換算） */
  cpu: number | null;
  /** コンテナのメモリ使用量（page cache のうち解放できる分を除く。docker stats と同じ） */
  memory: number;
  rss: number;
  heap: number;
}

export interface ResourceSnapshot {
  source: ResourceSource;
  intervalMs: number;
  limits: { cpu: number | null; cpuRaw: string | null; memory: number | null };
  samples: ResourceSample[];
}

interface Reader {
  source: ResourceSource;
  /** 累積 CPU 時間（マイクロ秒） */
  cpuUsec(): number;
  memory(): number;
  cpuLimit(): number | null;
  /** 上限の計算元（cgroup のファイルの中身そのまま） */
  cpuLimitRaw(): string | null;
  memoryLimit(): number | null;
}

const read = (file: string) => fs.readFileSync(file, "utf8").trim();
const statValue = (text: string, key: string) => Number(new RegExp(`^${key} (\\d+)$`, "m").exec(text)?.[1] ?? 0);
// cgroup v1 は上限なしのとき 2^63 付近の値を返す
const finiteLimit = (n: number) => (Number.isFinite(n) && n > 0 && n < 2 ** 60 ? n : null);

function cgroup2(root: string): Reader | null {
  if (!fs.existsSync(path.join(root, "cgroup.controllers")) || !fs.existsSync(path.join(root, "memory.current"))) return null;
  return {
    source: "cgroup2",
    cpuUsec: () => statValue(read(path.join(root, "cpu.stat")), "usage_usec"),
    memory: () => {
      const current = Number(read(path.join(root, "memory.current")));
      const stat = fs.existsSync(path.join(root, "memory.stat")) ? read(path.join(root, "memory.stat")) : "";
      return Math.max(0, current - statValue(stat, "inactive_file"));
    },
    cpuLimit: () => {
      const file = path.join(root, "cpu.max");
      if (!fs.existsSync(file)) return null;
      const [quota, period] = read(file).split(/\s+/);
      return quota === "max" ? null : Number(quota) / Number(period);
    },
    cpuLimitRaw: () => {
      const file = path.join(root, "cpu.max");
      return fs.existsSync(file) ? `cpu.max: ${read(file)}` : null;
    },
    memoryLimit: () => {
      const file = path.join(root, "memory.max");
      return fs.existsSync(file) && read(file) !== "max" ? finiteLimit(Number(read(file))) : null;
    },
  };
}

function cgroup1(root: string): Reader | null {
  const mem = path.join(root, "memory");
  const cpuacct = ["cpuacct", "cpu,cpuacct", "cpu"].map((d) => path.join(root, d)).find((d) => fs.existsSync(path.join(d, "cpuacct.usage")));
  if (!fs.existsSync(path.join(mem, "memory.usage_in_bytes")) || !cpuacct) return null;
  const cpu = ["cpu", "cpu,cpuacct"].map((d) => path.join(root, d)).find((d) => fs.existsSync(path.join(d, "cpu.cfs_quota_us")));
  return {
    source: "cgroup1",
    cpuUsec: () => Number(read(path.join(cpuacct, "cpuacct.usage"))) / 1000,
    memory: () => {
      const usage = Number(read(path.join(mem, "memory.usage_in_bytes")));
      const stat = fs.existsSync(path.join(mem, "memory.stat")) ? read(path.join(mem, "memory.stat")) : "";
      return Math.max(0, usage - statValue(stat, "total_inactive_file"));
    },
    cpuLimit: () => {
      if (!cpu) return null;
      const quota = Number(read(path.join(cpu, "cpu.cfs_quota_us")));
      return quota > 0 ? quota / Number(read(path.join(cpu, "cpu.cfs_period_us"))) : null;
    },
    cpuLimitRaw: () =>
      cpu ? `cpu.cfs_quota_us: ${read(path.join(cpu, "cpu.cfs_quota_us"))} / cpu.cfs_period_us: ${read(path.join(cpu, "cpu.cfs_period_us"))}` : null,
    memoryLimit: () => finiteLimit(Number(read(path.join(mem, "memory.limit_in_bytes")))),
  };
}

// cgroup が読めない環境（ローカル開発など）では Node プロセス自身の値を出す
const processReader: Reader = {
  source: "process",
  cpuUsec: () => {
    const u = process.cpuUsage();
    return u.user + u.system;
  },
  memory: () => process.memoryUsage.rss(),
  cpuLimit: () => os.availableParallelism(),
  cpuLimitRaw: () => null,
  memoryLimit: () => os.totalmem(),
};

export function detectReader(root = "/sys/fs/cgroup"): Reader {
  for (const make of [cgroup2, cgroup1]) {
    try {
      const reader = make(root);
      if (reader) {
        reader.cpuUsec();
        reader.memory();
        return reader;
      }
    } catch {
      // 読めなければ次を試す
    }
  }
  return processReader;
}

export class ResourceMonitor {
  #reader: Reader;
  #intervalMs: number;
  #capacity: number;
  #samples: ResourceSample[] = [];
  #prev: { t: number; usec: number } | null = null;
  #timer: NodeJS.Timeout;

  constructor(options: { root?: string; intervalMs?: number; keepMs?: number } = {}) {
    this.#reader = detectReader(options.root);
    this.#intervalMs = options.intervalMs ?? 5000;
    this.#capacity = Math.ceil((options.keepMs ?? 30 * 60_000) / this.#intervalMs);
    this.sample();
    this.#timer = setInterval(() => this.sample(), this.#intervalMs);
    this.#timer.unref();
  }

  sample(): void {
    const t = Date.now();
    let cpu: number | null = null;
    let memory: number;
    try {
      const usec = this.#reader.cpuUsec();
      if (this.#prev && t > this.#prev.t) cpu = Math.max(0, (usec - this.#prev.usec) / 1000 / (t - this.#prev.t));
      this.#prev = { t, usec };
      memory = this.#reader.memory();
    } catch (err) {
      console.error("[kanzume] リソースの計測に失敗:", err);
      return;
    }
    const mu = process.memoryUsage();
    this.#samples.push({ t, cpu, memory, rss: mu.rss, heap: mu.heapUsed });
    if (this.#samples.length > this.#capacity) this.#samples.splice(0, this.#samples.length - this.#capacity);
  }

  snapshot(): ResourceSnapshot {
    const limit = <T>(f: () => T): T | null => {
      try {
        return f();
      } catch {
        return null;
      }
    };
    return {
      source: this.#reader.source,
      intervalMs: this.#intervalMs,
      limits: { cpu: limit(this.#reader.cpuLimit), cpuRaw: limit(this.#reader.cpuLimitRaw), memory: limit(this.#reader.memoryLimit) },
      samples: this.#samples,
    };
  }

  close(): void {
    clearInterval(this.#timer);
  }
}
