import type { Release } from "../store.ts";
import { loadWorker, type LoadedWorker } from "./loader.ts";

interface Entry {
  release: Release;
  worker: Promise<LoadedWorker>;
  lastUsed: number;
}

export interface RuntimeOptions {
  siteDir: string;
  idleMs: number;
  cpuTimeoutMs: number;
}

export class Runtime {
  #entry: Entry | null = null;
  #options: RuntimeOptions;
  #timer: NodeJS.Timeout;

  constructor(options: RuntimeOptions) {
    this.#options = options;
    this.#timer = setInterval(() => this.sweep(), 60_000);
    this.#timer.unref();
  }

  get loaded(): boolean {
    return this.#entry !== null;
  }

  get(release: Release): Promise<LoadedWorker> {
    if (this.#entry?.release.id === release.id) {
      this.#entry.lastUsed = Date.now();
      return this.#entry.worker;
    }
    const entry: Entry = { release, worker: this.preload(release), lastUsed: Date.now() };
    this.#entry = entry;
    entry.worker.catch(() => {
      if (this.#entry === entry) this.#entry = null;
    });
    return entry.worker;
  }

  preload(release: Release): Promise<LoadedWorker> {
    return loadWorker(release, this.#options.siteDir, this.#options.cpuTimeoutMs);
  }

  install(worker: LoadedWorker): void {
    this.#entry = { release: worker.release, worker: Promise.resolve(worker), lastUsed: Date.now() };
  }

  evict(): void {
    this.#entry = null;
  }

  sweep(now = Date.now()): void {
    if (this.#entry && now - this.#entry.lastUsed > this.#options.idleMs) this.#entry = null;
  }

  close(): void {
    clearInterval(this.#timer);
    this.#entry = null;
  }
}
