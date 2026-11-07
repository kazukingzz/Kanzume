import type { Release } from "../store.ts";
import { loadWorker, type InvokeResult } from "./loader.ts";
import { ChildWorker } from "./process.ts";

/** 読み込んだ Worker（同じプロセスの LoadedWorker か、子プロセスの ChildWorker） */
export interface WorkerHandle {
  readonly release: Release;
  fetch(request: Request): Promise<InvokeResult>;
  close?(): void;
  readonly closed?: boolean;
  /** 子プロセスで動いているときのプロセス ID */
  readonly pid?: number;
}

interface Entry {
  release: Release;
  worker: Promise<WorkerHandle>;
  /** 読み込みが終わった Worker（子プロセスが落ちたかを見るため） */
  handle?: WorkerHandle;
  lastUsed: number;
}

export interface RuntimeOptions {
  idleMs: number;
  cpuTimeoutMs: number;
  /** 同時にメモリに載せておく Worker の数。超えたら最後に使ったのが一番古いものから捨てる */
  maxWorkers?: number;
  /**
   * process: サイトごとの子プロセスで動かす（本番。ほかのサイトや本体のデータに触れさせない）
   * inline: 本体と同じプロセスの node:vm で動かす（開発・テスト用。省略時）
   */
  isolation?: "process" | "inline";
  /** process のとき、サイトごとの uid の割り当てを保存する場所 */
  dataDir?: string;
}

/** 読み込んだ Worker をサイト（siteDir）ごとに 1 つずつ持つ */
export class Runtime {
  #entries = new Map<string, Entry>();
  #options: RuntimeOptions;
  #timer: NodeJS.Timeout;

  constructor(options: RuntimeOptions) {
    this.#options = options;
    this.#timer = setInterval(() => this.sweep(), 60_000);
    this.#timer.unref();
  }

  get loaded(): boolean {
    return this.#entries.size > 0;
  }

  get size(): number {
    return this.#entries.size;
  }

  get(release: Release): Promise<WorkerHandle> {
    const existing = this.#entries.get(release.siteDir);
    // 子プロセスが落ちていたら起動し直す
    if (existing?.release.id === release.id && !existing.handle?.closed) {
      existing.lastUsed = Date.now();
      return existing.worker;
    }
    const entry: Entry = { release, worker: this.preload(release), lastUsed: Date.now() };
    void entry.worker.then((w) => (entry.handle = w), () => {});
    this.#set(entry);
    entry.worker.catch(() => {
      if (this.#entries.get(release.siteDir) === entry) this.#entries.delete(release.siteDir);
    });
    return entry.worker;
  }

  /** 動いている Worker の子プロセス（リソースタブ用） */
  processes(): { siteDir: string; pid: number }[] {
    const out: { siteDir: string; pid: number }[] = [];
    for (const [siteDir, entry] of this.#entries) {
      const pid = entry.handle?.pid;
      if (pid !== undefined && !entry.handle?.closed) out.push({ siteDir, pid });
    }
    return out;
  }

  preload(release: Release): Promise<WorkerHandle> {
    if (this.#options.isolation === "process") {
      return ChildWorker.start(release, { dataDir: this.#options.dataDir ?? "/data", timeout: this.#options.cpuTimeoutMs });
    }
    return loadWorker(release, release.siteDir, this.#options.cpuTimeoutMs);
  }

  install(worker: WorkerHandle): void {
    this.#set({ release: worker.release, worker: Promise.resolve(worker), handle: worker, lastUsed: Date.now() });
  }

  /** 捨てた Worker が子プロセスなら止める */
  #drop(key: string): void {
    const entry = this.#entries.get(key);
    this.#entries.delete(key);
    entry?.worker.then((w) => w.close?.(), () => {});
  }

  #set(entry: Entry): void {
    const previous = this.#entries.get(entry.release.siteDir);
    if (previous && previous !== entry) this.#drop(entry.release.siteDir);
    this.#entries.set(entry.release.siteDir, entry);
    const max = this.#options.maxWorkers ?? Infinity;
    while (this.#entries.size > max) {
      let oldest: [string, Entry] | null = null;
      for (const e of this.#entries) if (e[1] !== entry && (!oldest || e[1].lastUsed < oldest[1].lastUsed)) oldest = e;
      if (!oldest) break;
      this.#drop(oldest[0]);
    }
  }

  /** siteDir を省略するとすべて捨てる */
  evict(siteDir?: string): void {
    if (siteDir === undefined) for (const key of [...this.#entries.keys()]) this.#drop(key);
    else this.#drop(siteDir);
  }

  sweep(now = Date.now()): void {
    for (const [key, entry] of [...this.#entries]) if (now - entry.lastUsed > this.#options.idleMs) this.#drop(key);
  }

  close(): void {
    clearInterval(this.#timer);
    this.evict();
  }
}
