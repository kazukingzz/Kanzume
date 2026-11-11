/** .assetsignore の中身から「アップロードしないか」を返す関数を作る（src/deploy/assetsignore.ts と同じ） */
export function parseAssetsIgnore(text: string): (rel: string) => boolean;
