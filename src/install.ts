/**
 * Kanzume 自身のファイルの場所。配る版（scripts/build.mjs で dist/ にまとめたもの）と、
 * 開発・テスト（TypeScript のまま動かす）で場所が違うものを、ここで決める
 *
 * 配る版:  dist/server.mjs（本体）・dist/child/child.mjs（Worker の子）・dist/hooks/*.mjs（git のフック）
 * 開発:    src/server.ts・src/runtime/child.ts・src/git/*.ts
 */
import path from "node:path";

/** scripts/build.mjs が true に置き換える */
declare const KANZUME_BUNDLED: boolean | undefined;

/** dist/ にまとめた版で動いているか */
export const bundled = typeof KANZUME_BUNDLED !== "undefined" && KANZUME_BUNDLED === true;

// まとめた版では、このファイルは dist/server.mjs の中にある。開発では src/install.ts
const here = import.meta.dirname;
const root = path.resolve(here, "..");

/** 管理画面のファイル（web/admin） */
export const webAdminDir = path.join(root, "web", "admin");

/**
 * Worker の子プロセスのエントリ。配る版ではまとめ済みの JS（そのまま起動できる）、
 * 開発では TypeScript（起動の前に process.ts が 1 ファイルにまとめる）
 */
export const childEntryFile = bundled ? path.join(here, "child", "child.mjs") : path.join(here, "runtime", "child.ts");

/** git のフック（post-receive・pre-receive）が実行するスクリプト */
export const hookScripts = {
  "post-receive": bundled ? path.join(here, "hooks", "hook.mjs") : path.join(here, "git", "hook.ts"),
  "pre-receive": bundled ? path.join(here, "hooks", "pre-receive.mjs") : path.join(here, "git", "pre-receive.ts"),
};
