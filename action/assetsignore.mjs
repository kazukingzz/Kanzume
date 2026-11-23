// .assetsignore（wrangler と同じく gitignore の書き方）を読み、アップロードしないファイルを決める。
// Action は依存なしで動かすので、src/deploy/assetsignore.ts と同じものをここにも置く（test/assetsignore.test.ts で一致を確かめる）

/** デプロイは本体のイベントループで動くので、書けるパターンの数と長さに上限を設ける */
export const MAX_RULES = 200;
export const MAX_PATTERN = 256;

/** 区切りの中のパターン（* は / 以外の 0 文字以上、? は / 以外の 1 文字、\ の次の文字はそのまま）を、文字ごとの配列にする */
function parseSegment(glob) {
  const chars = [];
  const wild = [];
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "\\" && i + 1 < glob.length) {
      chars.push(glob[++i]);
      wild.push(false);
    } else {
      chars.push(c);
      wild.push(c === "*" || c === "?");
    }
  }
  return { kind: "glob", chars, wild };
}

/**
 * 区切り 1 つを比べる。正規表現にすると * が並ぶパターンで後戻りが指数的に増えるので、
 * 最後の * まで戻るだけの方法で比べる（区切りの長さとパターンの長さの積で終わる）
 */
function matchSegment(seg, s) {
  const { chars, wild } = seg;
  let p = 0;
  let i = 0;
  let star = -1;
  let mark = 0;
  while (i < s.length) {
    if (p < chars.length && wild[p] && chars[p] === "*") {
      star = p++;
      mark = i;
    } else if (p < chars.length && (wild[p] ? chars[p] === "?" : chars[p] === s[i])) {
      p++;
      i++;
    } else if (star !== -1) {
      p = star + 1;
      i = ++mark;
    } else {
      return false;
    }
  }
  while (p < chars.length && wild[p] && chars[p] === "*") p++;
  return p === chars.length;
}

/**
 * gitignore のパターンの 1 つを区切りの列にする。「**」は区切り全体のときだけ特別で、
 * 先頭・途中の「**\/」は 0 個以上のディレクトリ、末尾の「/**」は中のすべて。それ以外の「**」は * が 2 つ
 */
function parsePattern(glob, anchored) {
  // 「\/」も区切り（パスの / に合う）。ほかの \ は区切りの中で読むので残す
  const parts = [];
  let cur = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "\\" && i + 1 < glob.length) {
      if (glob[i + 1] === "/") {
        parts.push(cur);
        cur = "";
      } else cur += c + glob[i + 1];
      i++;
    } else if (c === "/") {
      parts.push(cur);
      cur = "";
    } else cur += c;
  }
  parts.push(cur);
  const segments = anchored ? [] : [{ kind: "**" }];
  parts.forEach((part, i) => {
    if (part === "**") segments.push(i === parts.length - 1 ? { kind: "rest" } : { kind: "**" });
    else segments.push(parseSegment(part));
  });
  return segments;
}

/** パスの区切りの先頭 n 個がパターンに合うか。「**」のところは、試した組み合わせを覚えて同じものを二度試さない */
function matchPath(pattern, parts, n) {
  const seen = new Uint8Array((pattern.length + 1) * (n + 1));
  const go = (pi, si) => {
    while (true) {
      if (pi === pattern.length) return si === n;
      const seg = pattern[pi];
      if (seg.kind === "rest") return si < n;
      if (seg.kind === "**") {
        const at = pi * (n + 1) + si;
        if (seen[at]) return false;
        seen[at] = 1;
        for (let k = si; k <= n; k++) if (go(pi + 1, k)) return true;
        return false;
      }
      if (si === n || !matchSegment(seg, parts[si])) return false;
      pi++;
      si++;
    }
  };
  return go(0, 0);
}

/** 末尾の空白を消す（\ の直後の 1 文字は残す）。正規表現の \s+$ は、長い空白のあとに文字が続くと 2 乗の時間がかかる */
function trimTrailing(raw) {
  let end = raw.length;
  while (end > 0 && /\s/.test(raw[end - 1])) end--;
  if (end > 0 && end < raw.length && raw[end - 1] === "\\") end++;
  return raw.slice(0, end);
}

/**
 * .assetsignore の中身から「アップロードしないか」を返す関数を作る。パスは assets.directory からの相対（/ 区切り）。
 * ディレクトリが外されたら、その中のファイルは ! で戻せない（gitignore と同じ）
 */
export function parseAssetsIgnore(text) {
  const rules = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = trimTrailing(raw);
    if (!line || line.startsWith("#")) continue;
    if (line.length > MAX_PATTERN) throw new Error(`.assetsignore の 1 行は ${MAX_PATTERN} 文字以内にしてください`);
    if (rules.length >= MAX_RULES) throw new Error(`.assetsignore のパターンは ${MAX_RULES} 個以内にしてください`);
    let negate = false;
    if (line.startsWith("!")) {
      negate = true;
      line = line.slice(1);
    } else if (line.startsWith("\\!") || line.startsWith("\\#")) line = line.slice(1);
    const dirOnly = line.endsWith("/");
    let end = line.length;
    while (end > 0 && line[end - 1] === "/") end--;
    line = line.slice(0, end);
    const anchored = line.includes("/");
    if (line.startsWith("/")) line = line.slice(1);
    if (!line) continue;
    rules.push({ negate, dirOnly, pattern: parsePattern(line, anchored) });
  }
  return (rel) => {
    const parts = rel.split("/").filter(Boolean);
    for (let i = 1; i <= parts.length; i++) {
      const isDir = i < parts.length;
      let ignored = false;
      for (const r of rules) if ((!r.dirOnly || isDir) && matchPath(r.pattern, parts, i)) ignored = !r.negate;
      if (ignored) return true;
    }
    return false;
  };
}
