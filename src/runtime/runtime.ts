import type { Release } from "../store.ts";
import { loadWorker, type InvokeResult } from "./loader.ts";
import { ChildWorker } from "./process.ts";

/** 読み込んだ Worker（同じプロセスの LoadedWorker か、子プロセスの ChildWorker） */
export interface WorkerHandle {
  readonly release: Release;
  fetch(request: Request): Promise<InvokeResult>;
  close?(): void;
  /** 処理中のリクエストを終えてから止める（子プロセスのとき） */
  retire?(): void;
  readonly closed?: boolean;
  /** 処理中のリクエストがあるか（子プロセスのとき） */
  readonly busy?: boolean;
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
  #retiring = new Set<WorkerHandle>();
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
    if (existing && !existing.handle?.closed && (existing.release.id === release.id || existing.release.deployedAt > release.deployedAt)) {
      // デプロイの前に古いリリースを読んだリクエストは、入れたばかりの新しい Worker で受ける（新しいものを追い出さない）
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

  /** 動いている Worker の子プロセス（リソースタブ用）。処理中のリクエストを終えるのを待って止める途中のものも含む */
  processes(): { siteDir: string; pid: number }[] {
    const out: { siteDir: string; pid: number }[] = [];
    for (const [siteDir, entry] of this.#entries) {
      const pid = entry.handle?.pid;
      if (pid !== undefined && !entry.handle?.closed) out.push({ siteDir, pid });
    }
    for (const w of this.#liveRetiring()) if (w.pid !== undefined) out.push({ siteDir: w.release.siteDir, pid: w.pid });
    return out;
  }

  /** 止める途中（処理中のリクエストを終えるのを待っている）で、まだ動いている子 */
  #liveRetiring(): WorkerHandle[] {
    for (const w of this.#retiring) if (w.closed) this.#retiring.delete(w);
    return [...this.#retiring];
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

  /**
   * 捨てた Worker が子プロセスなら止める。now でなければ、処理中のリクエストと waitUntil を終えてから止める
   * （止める途中のものも数に含め、上限を超えたら古いものからすぐに止める）
   */
  #drop(key: string, now = false): void {
    const entry = this.#entries.get(key);
    this.#entries.delete(key);
    entry?.worker.then(
      (w) => {
        if (now || !w.retire) return w.close?.();
        w.retire();
        if (w.closed) return;
        this.#retiring.add(w);
        this.#limitRetiring();
      },
      () => {},
    );
  }

  #limitRetiring(): void {
    const max = this.#options.maxWorkers ?? Infinity;
    const retiring = this.#liveRetiring();
    // 動いている子の合計（使っているもの + 止める途中のもの）を上限に収める
    for (let i = 0; i < retiring.length && this.#entries.size + retiring.length - i > max; i++) {
      retiring[i].close?.();
      this.#retiring.delete(retiring[i]);
    }
  }

  #set(entry: Entry): void {
    const previous = this.#entries.get(entry.release.siteDir);
    if (previous && previous !== entry) this.#drop(entry.release.siteDir);
    this.#entries.set(entry.release.siteDir, entry);
    const max = this.#options.maxWorkers ?? Infinity;
    while (this.#entries.size > max) {
      let oldest: [string, Entry] | null = null;
      // 処理中のリクエストがないものを優先して追い出す
      const rank = (e: Entry) => (e.handle?.busy ? 1 : 0);
      for (const e of this.#entries) {
        if (e[1] === entry) continue;
        if (!oldest || rank(e[1]) < rank(oldest[1]) || (rank(e[1]) === rank(oldest[1]) && e[1].lastUsed < oldest[1].lastUsed)) oldest = e;
      }
      if (!oldest) break;
      this.#drop(oldest[0]);
    }
  }

  /**
   * siteDir を省略するとすべて捨てる。now なら処理中のリクエストも待たずに止める（サイトの削除のとき。
   * 消したあとに Worker が KV / R2 を書いてサイトのディレクトリを作り直さないように）
   */
  evict(siteDir?: string, options: { now?: boolean } = {}): void {
    const keys = siteDir === undefined ? [...this.#entries.keys()] : [siteDir];
    for (const key of keys) this.#drop(key, options.now);
    if (options.now) {
      for (const w of this.#liveRetiring()) {
        if (siteDir === undefined || w.release.siteDir === siteDir) {
          w.close?.();
          this.#retiring.delete(w);
        }
      }
    }
  }

  sweep(now = Date.now()): void {
    for (const [key, entry] of [...this.#entries]) {
      const idle = now - entry.lastUsed;
      // 長いストリーム（SSE やダウンロード）の途中のものは使用中として扱う。ただし応答しないまま止まった Worker を
      // いつまでも残さないよう、使用中でも idleMs の 6 倍（既定 1 時間）新しいリクエストがなければ止める
      if (idle > this.#options.idleMs && (!entry.handle?.busy || idle > this.#options.idleMs * 6)) this.#drop(key, Boolean(entry.handle?.busy));
    }
  }

  /** 本体の終了。子は（止める途中のものも）すぐに止める */
  close(): void {
    clearInterval(this.#timer);
    this.evict(undefined, { now: true });
  }
}
