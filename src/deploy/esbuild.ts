/**
 * esbuild を使う。esbuild は最初に使ったときに常駐プロセス（約 17 MiB）を起動し、そのまま残り続けるので、
 * 使い終わったら止める（次に使うときは自動で起動し直す）。使うのはデプロイのときだけ
 */
type Esbuild = typeof import("esbuild");

let users = 0;

export async function withEsbuild<T>(fn: (esbuild: Esbuild) => Promise<T>): Promise<T> {
  const esbuild = await import("esbuild");
  users++;
  try {
    return await fn(esbuild);
  } finally {
    // 同時に使っているものがすべて終わってから止める
    if (--users === 0) await esbuild.stop();
  }
}
