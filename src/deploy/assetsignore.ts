// .assetsignore（wrangler と同じく gitignore の書き方）を読み、アップロードしないファイルを決める。
// GitHub Actions の Action（action/assetsignore.mjs）にも同じものがある（test/assetsignore.test.ts で一致を確かめる）

/** gitignore のパターンの 1 つを正規表現の本体にする */
function globToRegex(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const before = i === 0 || glob[i - 1] === "/";
        const after = glob[i + 2] === undefined || glob[i + 2] === "/";
        if (before && after) {
          // 「**/」は 0 個以上のディレクトリ、末尾の「/**」は中のすべて
          out += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
          i += glob[i + 2] === "/" ? 2 : 1;
          continue;
        }
      }
      out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else if (c === "\\" && i + 1 < glob.length) out += `\\${glob[++i]}`;
    else out += /[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
  }
  return out;
}

/**
 * .assetsignore の中身から「アップロードしないか」を返す関数を作る。パスは assets.directory からの相対（/ 区切り）。
 * ディレクトリが外されたら、その中のファイルは ! で戻せない（gitignore と同じ）
 */
export function parseAssetsIgnore(text: string): (rel: string) => boolean {
  const rules: { negate: boolean; dirOnly: boolean; re: RegExp }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/(?<!\\)\s+$/, "");
    if (!line || line.startsWith("#")) continue;
    let negate = false;
    if (line.startsWith("!")) {
      negate = true;
      line = line.slice(1);
    } else if (line.startsWith("\\!") || line.startsWith("\\#")) line = line.slice(1);
    const dirOnly = line.endsWith("/");
    line = line.replace(/\/+$/, "");
    const anchored = line.includes("/");
    line = line.replace(/^\//, "");
    if (!line) continue;
    const body = globToRegex(line);
    rules.push({ negate, dirOnly, re: new RegExp(anchored ? `^${body}$` : `^(?:.*/)?${body}$`) });
  }
  return (rel: string) => {
    const parts = rel.split("/").filter(Boolean);
    for (let i = 1; i <= parts.length; i++) {
      const p = parts.slice(0, i).join("/");
      const isDir = i < parts.length;
      let ignored = false;
      for (const r of rules) if ((!r.dirOnly || isDir) && r.re.test(p)) ignored = !r.negate;
      if (ignored) return true;
    }
    return false;
  };
}
