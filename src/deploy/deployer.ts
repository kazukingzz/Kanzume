import { WorkerError } from "../runtime/loader.ts";
import type { Runtime } from "../runtime/runtime.ts";
import { PROJECT_NAME, type Manifest, type Release, type Store, type UploadedFile } from "../store.ts";
import type { DeployHistory, DeploySource } from "./history.ts";
import { CONFIG_FILES, ConfigError, parseWranglerConfig, toManifest } from "./wrangler.ts";

const MAX_SOURCES_BYTES = 5 * 1024 * 1024;

export class DeployLog {
  readonly lines: string[] = [];
  readonly started = performance.now();

  constructor(first: string) {
    this.lines.push(`${new Date().toISOString()} ${first}`);
  }

  add(message: string): void {
    this.lines.push(`[${String(Math.round(performance.now() - this.started)).padStart(5)}ms] ${message}`);
  }

  get elapsed(): number {
    return performance.now() - this.started;
  }

  toString(): string {
    return this.lines.join("\n");
  }
}

export interface DeployInput {
  files: UploadedFile[];
  sources: { path: string; content: string }[] | null;
  source: DeploySource;
  buildLog: string;
  log: DeployLog;
}

export type DeployResult = { ok: true; release: Release } | { ok: false; error: string };

function kib(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

function describe(manifest: Manifest): string {
  const parts = [`name=${manifest.name}`];
  if (manifest.main) parts.push(`main=worker/${manifest.main}`);
  if (manifest.assets) parts.push("assets");
  if (manifest.kvNamespaces.length) parts.push(`KV: ${manifest.kvNamespaces.map((k) => k.binding).join(", ")}`);
  if (manifest.r2Buckets.length) parts.push(`R2: ${manifest.r2Buckets.map((b) => b.binding).join(", ")}`);
  if (manifest.compatibilityFlags.length) parts.push(`flags: ${manifest.compatibilityFlags.join(", ")}`);
  return parts.join(" / ");
}

function sourcesFile(sources: DeployInput["sources"]): UploadedFile | null {
  if (!sources) return null;
  const cleaned = sources
    .filter((s) => s && typeof s.path === "string" && typeof s.content === "string")
    .map((s) => ({ path: s.path.replace(/\\/g, "/").replace(/^(\.\.\/)+/, ""), content: s.content }));
  const data = Buffer.from(JSON.stringify(cleaned));
  return data.length <= MAX_SOURCES_BYTES ? { path: "_sources.json", data } : null;
}

export class Deployer {
  #store: Store;
  #runtime: Runtime;
  #history: DeployHistory;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(store: Store, runtime: Runtime, history: DeployHistory) {
    this.#store = store;
    this.#runtime = runtime;
    this.#history = history;
  }

  #serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => {});
    return run;
  }

  recordFailure(name: string | null, error: string, input: Omit<DeployInput, "files" | "sources">, size = 0, files = 0): void {
    input.log.add(`失敗: ${error}`);
    this.#history.add({
      name: name ?? "",
      release: null,
      status: "failed",
      durationMs: input.log.elapsed,
      size,
      files,
      error,
      source: input.source,
      log: input.log.toString(),
      buildLog: input.buildLog,
    });
  }

  async deploy(input: DeployInput): Promise<DeployResult> {
    const { files, log } = input;
    const size = files.reduce((n, f) => n + f.data.length, 0);
    log.add(`受け取り: ${kib(size)}、${files.length} ファイル`);

    let name: string | null = null;
    const fail = (error: string): DeployResult => {
      this.recordFailure(name, error, input, size, files.length);
      return { ok: false, error };
    };

    const configFile = files.find((f) => (CONFIG_FILES as readonly string[]).includes(f.path));
    if (!configFile) return fail(`${CONFIG_FILES.join(" / ")} が含まれていません`);

    let manifest: Manifest;
    try {
      const raw = parseWranglerConfig(configFile.path, configFile.data.toString("utf8"));
      if (typeof raw.name === "string" && PROJECT_NAME.test(raw.name)) name = raw.name;
      manifest = toManifest(raw, files.some((f) => f.path.startsWith("worker/")));
      if (manifest.main && !files.some((f) => f.path === `worker/${manifest.main}`)) {
        throw new ConfigError(`バンドルに worker/${manifest.main} がありません（Kanzume の Action でデプロイしてください）`);
      }
      log.add(`設定: ${configFile.path}（${describe(manifest)}）`);
    } catch (err) {
      if (err instanceof ConfigError) return fail(err.message);
      throw err;
    }

    const kept = files.filter((f) => f.path.startsWith("worker/") || f.path.startsWith("assets/") || f === configFile);
    const sources = sourcesFile(input.sources);
    if (sources) kept.push(sources);

    const result = await this.#serialize(async (): Promise<DeployResult> => {
      const release = await this.#store.createRelease(manifest, kept);
      log.add(`リリース ${release.id} を保存しました`);
      let worker = null;
      if (manifest.main) {
        const loadStarted = performance.now();
        try {
          worker = await this.#runtime.preload(release);
          log.add(`Worker を読み込みました（${Math.round(performance.now() - loadStarted)}ms）`);
        } catch (err) {
          await this.#store.discard(release);
          if (err instanceof WorkerError) return { ok: false, error: err.message };
          throw err;
        }
      }
      await this.#store.activate(release);
      if (worker) this.#runtime.install(worker);
      else this.#runtime.evict();
      log.add("新しいリリースに切り替えました");
      return { ok: true, release };
    });

    if (!result.ok) return fail(result.error);
    this.#history.add({
      id: result.release.id,
      name: manifest.name,
      release: result.release.id,
      status: "success",
      durationMs: log.elapsed,
      size,
      files: files.length,
      error: null,
      source: input.source,
      log: log.toString(),
      buildLog: input.buildLog,
    });
    console.log(`[deploy] ${manifest.name} → ${result.release.id}`);
    return result;
  }
}
