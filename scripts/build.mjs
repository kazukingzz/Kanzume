// 配る用に、TypeScript のソースを 1 ファイルずつの JS にまとめる（dist/）。
// TypeScript のまま起動すると、実行時の変換と数百のモジュールで、待機中のメモリが約 40 MiB 多くなるため。
// 開発（npm start / npm run dev）とテストは、TypeScript のまま動かす
import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
// 出力先（省略すると dist/）。テストでは一時ディレクトリに作る
const dist = path.resolve(process.argv[2] ?? path.join(root, "dist"));
fs.rmSync(dist, { recursive: true, force: true });

const common = {
  absWorkingDir: root,
  outdir: dist,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  // esbuild は実行ファイルを伴うので、まとめずに node_modules から読む（デプロイのときだけ使う）
  external: ["esbuild"],
  // まとめた版の印（src/install.ts が見る）
  define: { KANZUME_BUNDLED: "true" },
  // まとめた CommonJS の依存が require を使えるようにする
  banner: { js: 'import { createRequire as __kanzumeCreateRequire } from "node:module";\nconst require = __kanzumeCreateRequire(import.meta.url);' },
  legalComments: "none",
  logLevel: "warning",
};

// 出力の場所は src/install.ts と合わせる。
// 本体: 動的に import するもの（パスキーのライブラリ）は別のファイル（dist/chunks/）に分け、使うときに読み込む
await build({ ...common, entryPoints: [{ in: "src/server.ts", out: "server" }], splitting: true, chunkNames: "chunks/[name]-[hash]" });
// Worker の子プロセスと git のフック: それぞれ 1 ファイルで完結させる
// （子プロセスは自分のディレクトリ dist/child しか読めないので、本体とは別のディレクトリに置き、ファイルを分けない）
await build({
  ...common,
  entryPoints: [
    { in: "src/runtime/child.ts", out: "child/child" },
    { in: "src/git/hook.ts", out: "hooks/hook" },
    { in: "src/git/pre-receive.ts", out: "hooks/pre-receive" },
  ],
});

for (const file of fs.readdirSync(dist, { recursive: true })) {
  const p = path.join(dist, String(file));
  if (fs.statSync(p).isFile()) console.log(`${path.relative(root, p)}  ${(fs.statSync(p).size / 1024).toFixed(0)} KiB`);
}
