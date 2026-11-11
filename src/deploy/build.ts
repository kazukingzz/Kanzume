/**
 * ファイル（wrangler の設定があるディレクトリからの相対パス）を、wrangler と同じ解釈でバンドルしてデプロイする。
 * ファイルのアップロード・GitHub の公開リポジトリ・サイトのリポジトリへの git push で使う
 * （GitHub Actions は Action の中で wrangler がビルドする）
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Plugin } from "esbuild";
import { UserFacingError } from "../errors.ts";
import { isInside } from "../paths.ts";
import type { UploadedFile } from "../store.ts";
import { parseAssetsIgnore } from "./assetsignore.ts";
import type { Deployer, DeployLog, DeployResult } from "./deployer.ts";
import type { DeploySource } from "./history.ts";
import { findConfigFile, parseWranglerConfig } from "./wrangler.ts";

/** ビルドの失敗（設定ファイルがない・バンドルできないなど）。メッセージは利用者に見せる */
export class BuildError extends UserFacingError {}

async function collect(root: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(path.join(root, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await collect(root, p)));
    else if (entry.isFile()) out.push(p);
  }
  return out;
}

// esbuild の既定の解決に任せないのは、信頼できないリポジトリが /data などサーバー上のファイルを
// import してバンドルに埋め込めてしまうため
function confine(root: string): Plugin {
  return {
    name: "kanzume-confine",
    setup(build) {
      build.onResolve({ filter: /.*/ }, async (args) => {
        if (args.pluginData === "confined") return undefined;
        const result = await build.resolve(args.path, {
          kind: args.kind,
          importer: args.importer,
          resolveDir: args.resolveDir,
          pluginData: "confined",
        });
        if (result.errors.length || result.external || result.namespace !== "file") return result;
        const real = await fs.realpath(result.path).catch(() => result.path);
        if (!isInside(root, real)) return { errors: [{ text: `リポジトリの外のファイルは import できません: ${args.path}` }] };
        return result;
      });
    },
  };
}

function hint(message: string): string {
  if (/Could not resolve "(?!\.)/.test(message)) return `${message}\nnpm パッケージを使うリポジトリは GitHub Actions でデプロイしてください`;
  return message;
}

export interface BuildContext {
  source: DeploySource;
  log: DeployLog;
  buildLog: string[];
  /** 設定ファイルが見つからないときのメッセージに使う場所の説明 */
  where?: string;
  /** 最初のデプロイのとき、このサイトをルートドメインにしてよいか（管理者のデプロイのときだけ） */
  autoRoot?: boolean;
  /** デプロイ先のサイト（管理画面で追加済みのもの。wrangler の name は使わない） */
  siteName: string;
}

/** ビルド・デプロイの失敗を履歴に残し、結果にする。UserFacingError 以外は作りの誤りとしてログにも出す */
export function recordBuildFailure(deployer: Deployer, err: unknown, ctx: BuildContext, label: string): DeployResult {
  const known = err instanceof UserFacingError;
  if (!known) console.error(`[deploy] ${label}で例外:`, err);
  const message = known ? err.message : `デプロイに失敗しました: ${(err as Error)?.message ?? err}`;
  deployer.recordFailure(ctx.siteName, message, { source: ctx.source, buildLog: ctx.buildLog.join("\n"), log: ctx.log });
  return { ok: false, error: message };
}

/** ファイルを作業ディレクトリに書き出してから、deployFromDirectory でビルドしてデプロイする */
export async function deployFromFiles(files: UploadedFile[], deployer: Deployer, ctx: BuildContext): Promise<DeployResult> {
  const work = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "kanzume-build-")));
  try {
    for (const f of files) {
      const dest = path.join(work, f.path);
      if (!isInside(work, dest)) continue;
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, f.data);
    }
    return await deployFromDirectory(work, deployer, ctx);
  } catch (err) {
    return recordBuildFailure(deployer, err, ctx, "デプロイ");
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

/** 取り出し済みのディレクトリ（git push では git が直接書き出す）からビルドしてデプロイする。ディレクトリの後片付けは呼び出し側 */
export async function deployFromDirectory(work: string, deployer: Deployer, ctx: BuildContext): Promise<DeployResult> {
  const { log, buildLog } = ctx;

  try {
    const configFile = await findConfigFile(
      (c) =>
        fs
          .stat(path.join(work, c))
          .then((st) => st.isFile())
          .catch(() => false),
      ctx.where ?? "リポジトリのトップ",
    );
    const text = await fs.readFile(path.join(work, configFile), "utf8");
    const config = parseWranglerConfig(configFile, text);
    const build = config.build as { command?: string } | undefined;
    if (build?.command) buildLog.push(`build.command（${build.command}）は実行しません。ビルドが必要な場合は GitHub Actions でデプロイしてください`);

    const out: UploadedFile[] = [{ path: configFile, data: Buffer.from(text) }];
    let sources: { path: string; content: string }[] | null = null;

    if (typeof config.main === "string") {
      const { build: esbuild } = await import("esbuild");
      const entry = path.resolve(work, config.main);
      if (!isInside(work, entry)) throw new BuildError("main のパスが不正です");
      const alias = (config.alias ?? {}) as Record<string, unknown>;
      for (const [from, to] of Object.entries(alias)) {
        if (typeof to !== "string" || path.isAbsolute(to) || to.split(/[\\/]/).includes("..")) {
          throw new BuildError(`alias の ${from} にリポジトリの外は指定できません`);
        }
      }
      const base = path.basename(config.main).replace(/\.[^.]+$/, "");
      buildLog.push(`$ esbuild ${config.main} --bundle --format=cjs（Kanzume 内でバンドル）`);
      try {
        const result = await esbuild({
          entryPoints: [entry],
          absWorkingDir: work,
          bundle: true,
          format: "cjs",
          platform: "node",
          target: "es2022",
          conditions: ["workerd", "worker", "browser"],
          external: ["cloudflare:*"],
          loader: { ".txt": "text", ".html": "text", ".sql": "text", ".bin": "binary" },
          define: (config.define as Record<string, string>) ?? {},
          alias: alias as Record<string, string>,
          plugins: [confine(work)],
          write: false,
          metafile: true,
          logLevel: "silent",
          outfile: path.join(work, ".kanzume-out", `${base}.cjs`),
        });
        for (const w of result.warnings) buildLog.push(`▲ ${w.text}`);
        out.push({ path: `worker/${base}.cjs`, data: Buffer.from(result.outputFiles[0].contents) });
        sources = [];
        for (const p of Object.keys(result.metafile.inputs)) {
          const file = path.resolve(work, p);
          if (p.split("/").includes("node_modules") || !isInside(work, file)) continue;
          sources.push({ path: p, content: await fs.readFile(file, "utf8") });
        }
        buildLog.push(`バンドルしました: worker/${base}.cjs（${(out[1].data.length / 1024).toFixed(1)} KiB、ソース ${sources.length} ファイル）`);
      } catch (err) {
        const errors = (err as { errors?: { text: string; location?: { file: string; line: number } | null }[] }).errors;
        const message = errors?.length
          ? errors.map((e) => (e.location ? `${e.location.file}:${e.location.line}: ${e.text}` : e.text)).join("\n")
          : (err as Error).message;
        buildLog.push(`✘ ${message}`);
        throw new BuildError(hint(message));
      }
    }

    const assets = config.assets as { directory?: string } | undefined;
    if (assets?.directory) {
      const assetsRoot = path.resolve(work, assets.directory);
      if (!isInside(work, assetsRoot)) throw new BuildError("assets.directory のパスが不正です");
      const exists = await fs
        .stat(assetsRoot)
        .then((s) => s.isDirectory())
        .catch(() => false);
      if (!exists)
        throw new BuildError(`assets.directory（${assets.directory}）がリポジトリにありません。ビルドが必要なサイトは GitHub Actions でデプロイしてください`);
      // .assetsignore に書いたもの（_worker.js など）は配信しない。.assetsignore 自体も
      const ignoreFile = await fs.readFile(path.join(assetsRoot, ".assetsignore"), "utf8").catch(() => "");
      const ignored = parseAssetsIgnore(ignoreFile);
      const list = (await collect(assetsRoot)).filter((p) => p !== ".assetsignore" && !ignored(p));
      for (const p of list) out.push({ path: `assets/${p}`, data: await fs.readFile(path.join(assetsRoot, p)) });
      buildLog.push(`アセット: ${assets.directory}（${list.length} ファイル）`);
    }

    return await deployer.deploy({
      files: out,
      sources,
      source: ctx.source,
      buildLog: buildLog.join("\n"),
      log,
      autoRoot: ctx.autoRoot,
      siteName: ctx.siteName,
    });
  } catch (err) {
    return recordBuildFailure(deployer, err, ctx, "デプロイ");
  }
}
