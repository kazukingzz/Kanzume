import { WorkerError } from "../runtime/loader.ts";
import type { Runtime } from "../runtime/runtime.ts";
import { SerialQueue } from "../serial.ts";
import { siteNotFound, type Sites } from "../sites.ts";
import type { Manifest, Release, UploadedFile } from "../store.ts";
import type { DeployHistory, DeploySource } from "./history.ts";
import { CONFIG_FILES, ConfigError, parseWranglerConfig, toManifest } from "./wrangler.ts";

const MAX_SOURCES_BYTES = 5 * 1024 * 1024;

export class DeployLog {
  readonly lines: string[] = [];
  readonly started = performance.now();

  readonly onLine?: (message: string) => void;

  /** onLine を渡すと、行が増えるたびに呼ぶ（git push の出力に流すため） */
  constructor(first: string, onLine?: (message: string) => void) {
    this.onLine = onLine;
    this.lines.push(`${new Date().toISOString()} ${first}`);
    onLine?.(first);
  }

  add(message: string): void {
    this.lines.push(`[${String(Math.round(performance.now() - this.started)).padStart(5)}ms] ${message}`);
    this.onLine?.(message);
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
  /**
   * ルートドメインで配信するサイトがまだないとき、このサイトをルートにするか。
   * ルートは管理画面と同じオリジンなので、管理者のデプロイのときだけ true にする（ルートにするのは、メンバーのいないサイトだけ）
   */
  autoRoot?: boolean;
  /**
   * デプロイ先のサイト（管理画面で追加済みのもの）。wrangler の name は使わない。
   * サイトはデプロイでは作らない（先に管理画面でサイトを追加する）
   */
  siteName: string;
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
  #sites: Sites;
  #runtime: Runtime;
  #history: DeployHistory;
  #queue = new SerialQueue();
  #sitesQueue = new SerialQueue();
  /** デプロイが成功したあとに呼ぶ（バックアップのきっかけ） */
  onChange: (() => void) | null = null;

  /**
   * そのサイトをルートドメインにしてよいか。ルートは管理画面と同じオリジンで動くので、メンバーのいるサイトはルートにしない。
   * server.ts が管理画面の状態から決める
   */
  canBeRoot: (site: string) => boolean = () => true;

  constructor(sites: Sites, runtime: Runtime, history: DeployHistory) {
    this.#sites = sites;
    this.#runtime = runtime;
    this.#history = history;
  }

  /**
   * 同じサイトへの「リポジトリを読み書きしてデプロイする」一連の処理を 1 つずつにする
   * （git push のデプロイと、ファイルのアップロードのコミット → デプロイ → ブランチを進める、が交ざらないように）
   */
  exclusive<T>(site: string, fn: () => Promise<T>): Promise<T> {
    return this.#sitesQueue.run(site, fn);
  }

  /**
   * 大きな本文を受け取って展開する処理（ファイルのアップロード・GitHub からの取得・Actions）は、本体で 1 つずつにする
   * （展開したファイルとビルドでメモリを多く使うため。待たせるだけで断らない）
   */
  intake<T>(fn: () => Promise<T>): Promise<T> {
    return this.#queue.run("intake", fn);
  }

  #serialize<T>(fn: () => Promise<T>): Promise<T> {
    return this.#queue.run("deploy", fn);
  }

  recordFailure(name: string | null, error: string, input: Pick<DeployInput, "source" | "buildLog" | "log">, size = 0, files = 0): void {
    input.log.add(`失敗: ${error}`);
    this.#history.add({
      // 履歴は管理画面で追加したサイトにだけ残す
      name: name && this.#sites.has(name) ? name : "",
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

    // 失敗の履歴は、あるサイトにだけ残す
    const name: string | null = this.#sites.has(input.siteName) ? input.siteName : null;
    const fail = (error: string): DeployResult => {
      this.recordFailure(name, error, input, size, files.length);
      return { ok: false, error };
    };

    if (!name) return fail(siteNotFound(input.siteName).message);
    // 設定ファイルが複数あれば、ほかのデプロイ方法と同じく CONFIG_FILES の順に選ぶ
    const configName = CONFIG_FILES.find((c) => files.some((f) => f.path === c));
    const configFile = files.find((f) => f.path === configName);
    if (!configFile) return fail(`${CONFIG_FILES.join(" / ")} が含まれていません`);

    let manifest: Manifest;
    try {
      const raw = parseWranglerConfig(configFile.path, configFile.data.toString("utf8"));
      // wrangler の name は見ない（デプロイ先は指定されたサイト）
      raw.name = name;
      manifest = toManifest(
        raw,
        files.some((f) => f.path.startsWith("worker/")),
      );
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
      // 待っている間に消されたサイトにはデプロイしない
      const store = this.#sites.get(manifest.name);
      if (!store) return { ok: false, error: siteNotFound(manifest.name).message } as const;
      const release = await store.createRelease(manifest, kept);
      log.add(`リリース ${release.id} を保存しました`);
      let worker = null;
      if (manifest.main) {
        const loadStarted = performance.now();
        try {
          worker = await this.#runtime.preload(release);
          log.add(`Worker を読み込みました（${Math.round(performance.now() - loadStarted)}ms）`);
        } catch (err) {
          await store.discard(release);
          if (err instanceof WorkerError) return { ok: false, error: err.message };
          throw err;
        }
      }
      try {
        // 切り替えと同じタイミングで新しい Worker を入れる（間に来たリクエストが古い Worker や二重の起動に当たらないように）
        await store.activate(release, () => {
          if (worker) this.#runtime.install(worker);
          else this.#runtime.evict(store.siteDir);
        });
      } catch (err) {
        worker?.close?.();
        throw err;
      }
      // ルートドメインのサイトは、Kanzume で最初のデプロイのときにだけ自動で決める。
      // 管理者のデプロイならそのサイト、メンバーのデプロイなら「ルートなし」で確定させる（後からメンバーのサイトがルートにならないように）
      if (!this.#sites.rootDecided) await this.#sites.setRoot(input.autoRoot && this.canBeRoot(manifest.name) ? manifest.name : null);
      log.add("新しいリリースに切り替えました");
      this.onChange?.();
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
