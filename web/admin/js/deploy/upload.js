// ---------- ファイルのドラッグ＆ドロップでデプロイ ----------

export const CONFIG_NAMES = ["wrangler.jsonc", "wrangler.json", "wrangler.toml"];

/** デプロイに含めないもの */
export const UPLOAD_SKIP = /(^|\/)(\.git|node_modules|__MACOSX)(\/|$)|(^|\/)\.DS_Store$/;

// ドロップの場所を外したときに、ブラウザがファイルを開いて管理画面から離れないようにする
for (const type of ["dragover", "drop"]) window.addEventListener(type, (e) => e.dataTransfer?.types?.includes("Files") && e.preventDefault());

export const readEntryFile = (entry) => new Promise((resolve, reject) => entry.file(resolve, reject));

export async function readDirEntries(dir) {
  const reader = dir.createReader();
  const all = [];
  // readEntries は 100 件ずつしか返さないので、空になるまで読む
  for (;;) {
    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) return all;
    all.push(...batch);
  }
}

/** ドロップされたもの（フォルダを含む）を { path, file } の一覧にする */
export async function droppedFiles(dataTransfer) {
  const entries = [...(dataTransfer.items ?? [])].map((i) => (i.kind === "file" ? i.webkitGetAsEntry?.() : null)).filter(Boolean);
  if (!entries.length) return [...dataTransfer.files].map((file) => ({ path: file.name, file }));
  const out = [];
  const walk = async (entry) => {
    if (UPLOAD_SKIP.test(entry.fullPath.slice(1))) return;
    if (entry.isFile) out.push({ path: entry.fullPath.replace(/^\/+/, ""), file: await readEntryFile(entry) });
    else if (entry.isDirectory) for (const child of await readDirEntries(entry)) await walk(child);
  };
  for (const e of entries) await walk(e);
  return out;
}

/** zip を展開する（stored と deflate。暗号化・ZIP64 は非対応） */
export async function unzip(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip を読めませんでした（壊れているか、zip ではありません）");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  if (count === 0xffff || p === 0xffffffff) throw new Error("ZIP64 形式の zip には対応していません");
  const decoder = new TextDecoder();
  const out = [];
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error("zip のディレクトリが壊れています");
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = decoder.decode(buf.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    if (flags & 1) throw new Error("パスワード付きの zip には対応していません");
    if (compSize === 0xffffffff) throw new Error("ZIP64 形式の zip には対応していません");
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = buf.subarray(start, start + compSize);
    let data;
    if (method === 0) data = new Blob([raw]);
    else if (method === 8) data = await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).blob();
    else throw new Error(`zip の圧縮方式（${method}）に対応していません: ${name}`);
    out.push({ path: name, file: data });
  }
  return out;
}

/** 取り込むファイルを整える: 除くものを外し、zip を展開し、共通の先頭のフォルダを取る */
export async function prepareUpload(files) {
  if (files.length === 1 && /\.zip$/i.test(files[0].path)) files = await unzip(files[0].file);
  files = files
    .map((f) => ({ ...f, path: f.path.replace(/\\/g, "/").replace(/^\/+/, "") }))
    .filter((f) => f.path && !UPLOAD_SKIP.test(f.path) && !f.path.split("/").some((s) => s === ".." || s === "."));
  // dist/ などのフォルダを丸ごと落としたときは、その中身をトップにする
  for (;;) {
    const first = files[0]?.path.split("/")[0];
    if (!first || !files.every((f) => f.path.startsWith(`${first}/`))) break;
    files = files.map((f) => ({ ...f, path: f.path.slice(first.length + 1) }));
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** ustar の tar（パスは pax ヘッダーに入れるので、長い名前や日本語も使える）を gzip にする */
export async function tarGz(files) {
  const enc = new TextEncoder();
  const parts = [];
  const header = (name, size, type) => {
    const b = new Uint8Array(512);
    const put = (s, off, len) => b.set(enc.encode(s).subarray(0, len), off);
    const octal = (v, len) => `${v.toString(8).padStart(len - 1, "0")}\0`;
    put(name, 0, 100);
    put(octal(0o644, 8), 100, 8);
    put(octal(0, 8), 108, 8);
    put(octal(0, 8), 116, 8);
    put(octal(size, 12), 124, 12);
    put(octal(Math.floor(Date.now() / 1000), 12), 136, 12);
    put("        ", 148, 8);
    put(type, 156, 1);
    put("ustar\0", 257, 6);
    put("00", 263, 2);
    let sum = 0;
    for (const x of b) sum += x;
    put(`${octal(sum, 7)} `, 148, 8);
    return b;
  };
  const pad = (n) => new Uint8Array((512 - (n % 512)) % 512);
  for (const f of files) {
    const body = ` path=${f.path}\n`;
    let len = enc.encode(body).length;
    let record = `${len}${body}`;
    while (enc.encode(record).length !== len) {
      len = enc.encode(record).length;
      record = `${len}${body}`;
    }
    const pax = enc.encode(record);
    parts.push(header("PaxHeader", pax.length, "x"), pax, pad(pax.length));
    parts.push(header(f.path.slice(-100).replace(/[^\x20-\x7e]/g, "_"), f.file.size, "0"), f.file, pad(f.file.size));
  }
  parts.push(new Uint8Array(1024));
  return new Response(new Blob(parts).stream().pipeThrough(new CompressionStream("gzip"))).blob();
}

/** 取り込むファイルから、どうデプロイされるかを決める */
export async function uploadPlan(files) {
  // サーバーと同じ優先順（wrangler.jsonc → wrangler.json → wrangler.toml）で選ぶ
  const config = CONFIG_NAMES.map((n) => files.find((f) => f.path === n)).find(Boolean);
  if (!config) return { config: null, worker: false, index: files.some((f) => f.path === "index.html") };
  const text = await config.file.text();
  const worker = config.path.endsWith(".toml") ? /^\s*main\s*=/m.test(text) : /"main"\s*:/.test(text);
  return { config: config.path, worker, index: true };
}
