// wrangler の出力（ESM）を Kanzume が読み込める CommonJS に変換する esbuild の引数
export function esbuildArgs(entry, outfile) {
  return [
    entry,
    "--bundle",
    "--format=cjs",
    "--platform=node",
    "--target=es2022",
    "--external:cloudflare:*",
    "--external:*.wasm",
    "--external:*.txt",
    "--external:*.html",
    "--external:*.sql",
    "--external:*.bin",
    `--outfile=${outfile}`,
    "--log-level=warning",
  ];
}
