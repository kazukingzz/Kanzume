import type { Release } from "../store.ts";
import { loadWorker, type LoadedWorker } from "./loader.ts";

interface Entry {
  release: Release;
  worker: Promise<LoadedWorker>;
  lastUsed: number;
}

export interface RuntimeOptions {
  idleMs: number;
  cpuTimeoutMs: number;
  /** 同時にメモリに載せておく Worker の数。超えたら最後に使ったのが一番古いものから捨てる */
  maxWorkers?: number;
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

  get(release: Release): Promise<LoadedWorker> {
    const existing = this.#entries.get(release.siteDir);
    if (existing?.release.id === release.id) {
      existing.lastUsed = Date.now();
      return existing.worker;
    }
    const entry: Entry = { release, worker: this.preload(release), lastUsed: Date.now() };
    this.#set(entry);
    entry.worker.catch(() => {
      if (this.#entries.get(release.siteDir) === entry) this.#entries.delete(release.siteDir);
    });
    return entry.worker;
  }

  preload(release: Release): Promise<LoadedWorker> {
    return loadWorker(release, release.siteDir, this.#options.cpuTimeoutMs);
  }

  install(worker: LoadedWorker): void {
    this.#set({ release: worker.release, worker: Promise.resolve(worker), lastUsed: Date.now() });
  }

  #set(entry: Entry): void {
    this.#entries.set(entry.release.siteDir, entry);
    const max = this.#options.maxWorkers ?? Infinity;
    while (this.#entries.size > max) {
      let oldest: [string, Entry] | null = null;
      for (const e of this.#entries) if (e[1] !== entry && (!oldest || e[1].lastUsed < oldest[1].lastUsed)) oldest = e;
      if (!oldest) break;
      this.#entries.delete(oldest[0]);
    }
  }

  /** siteDir を省略するとすべて捨てる */
  evict(siteDir?: string): void {
    if (siteDir === undefined) this.#entries.clear();
    else this.#entries.delete(siteDir);
  }

  sweep(now = Date.now()): void {
    for (const [key, entry] of this.#entries) if (now - entry.lastUsed > this.#options.idleMs) this.#entries.delete(key);
  }

  close(): void {
    clearInterval(this.#timer);
    this.#entries.clear();
  }
}
