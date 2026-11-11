import { execFile } from "node:child_process";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { PROJECT_NAME, type UploadedFile } from "../store.ts";

const run = promisify(execFile);
const MAX_BLOB = 1024 * 1024;

export class RepoError extends Error {}

export interface RepoSummary {
  name: string;
  defaultBranch: string;
  lastPush: string | null;
  size: number;
}

/** git に渡す前に、オプションと間違えられる値や .. を含む値を弾く */
function safeRef(ref: string): string {
  if (!ref || ref.startsWith("-") || /[\s~^:?*[\\]|\.\.|@\{/.test(ref)) throw new RepoError("ブランチ名が不正です");
  return ref;
}

function safePath(p: string): string {
  const clean = p.replace(/^\/+|\/+$/g, "");
  if (clean.split("/").some((s) => s === ".." || s === ".")) throw new RepoError("パスが不正です");
  return clean;
}

/** `ls-tree -l -z` の 1 件（`<mode> <type> <sha> <size>\t<path>`）。パスにタブがあっても最初のタブで分ける */
function parseTreeEntry(entry: string) {
  const tab = entry.indexOf("\t");
  const [, type, sha, size] = entry.slice(0, tab).split(/\s+/);
  return { path: entry.slice(tab + 1), type, sha, size: Number(size) || 0 };
}

/** ディレクトリの中身の合計サイズ（バイト） */
export async function dirSize(dir: string): Promise<number> {
  let total = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(p);
    else if (entry.isFile()) total += (await fs.stat(p).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

/**
 * Kanzume が持つ Git のリモートリポジトリ（bare）。push は `git http-backend` が受け、読み取りは git コマンドで行う。
 * 置き場所は `<dataDir>/repos/<name>.git`。
 */
export class Repos {
  readonly dir: string;
  readonly maxInputBytes: number;
  readonly quotaBytes: number;
  /** 作成・削除のあとに呼ぶ（バックアップのきっかけ。push はデプロイか定期バックアップで拾う） */
  onChange: (() => void) | null = null;

  constructor(dataDir: string, maxInputBytes: number, quotaBytes = maxInputBytes * 4) {
    this.dir = path.join(dataDir, "repos");
    this.maxInputBytes = maxInputBytes;
    this.quotaBytes = quotaBytes;
  }

  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
  }

  path(name: string): string {
    return path.join(this.dir, `${name}.git`);
  }

  git(name: string, args: string[], options: { maxBuffer?: number; encoding?: "buffer"; env?: Record<string, string> } = {}) {
    return run("git", ["--git-dir", path.resolve(this.path(name)), ...args], {
      maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
      encoding: (options.encoding ?? "utf8") as BufferEncoding,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", ...options.env },
    });
  }

  async exists(name: string): Promise<boolean> {
    if (!PROJECT_NAME.test(name)) return false;
    return fs
      .stat(path.join(this.path(name), "HEAD"))
      .then(() => true)
      .catch(() => false);
  }

  /** リポジトリとして使えるもの（HEAD があるもの）だけ。作りかけや消しかけのディレクトリは含めない */
  async names(): Promise<string[]> {
    const entries = await fs.readdir(this.dir).catch(() => [] as string[]);
    const names = entries
      .filter((e) => e.endsWith(".git"))
      .map((e) => e.slice(0, -4))
      .filter((n) => PROJECT_NAME.test(n));
    const ok = await Promise.all(names.map((n) => this.exists(n)));
    return names.filter((_, i) => ok[i]).sort();
  }

  async create(name: string): Promise<void> {
    if (!PROJECT_NAME.test(name)) throw new RepoError("名前は英小文字・数字・ハイフンで 63 文字以内にしてください");
    if (await this.exists(name)) throw new RepoError("同じ名前のリポジトリがあります");
    await run("git", ["init", "--quiet", "--bare", "--initial-branch=main", this.path(name)]);
    this.onChange?.();
  }

  async remove(name: string): Promise<void> {
    if (!(await this.exists(name))) return;
    await fs.rm(this.path(name), { recursive: true, force: true });
    this.onChange?.();
  }

  /** HEAD が指すブランチ。--short を使わないのは、同じ名前のタグがあると heads/main のように返るため */
  async defaultBranch(name: string): Promise<string> {
    const head = await fs.readFile(path.join(this.path(name), "HEAD"), "utf8").catch(() => "");
    const m = /^ref: refs\/heads\/(.+)$/m.exec(head);
    return m?.[1].trim() || "main";
  }

  async summary(name: string): Promise<RepoSummary> {
    const [defaultBranch, { stdout }, size] = await Promise.all([
      this.defaultBranch(name),
      this.git(name, ["for-each-ref", "--sort=-committerdate", "--count=1", "--format=%(committerdate:iso-strict)", "refs/heads"]),
      dirSize(path.join(this.path(name), "objects")),
    ]);
    return { name, defaultBranch, lastPush: String(stdout).trim() || null, size };
  }

  async refs(name: string) {
    const { stdout } = await this.git(name, [
      "for-each-ref",
      "--sort=-committerdate",
      "--format=%(refname:short)%00%(objectname)%00%(committerdate:iso-strict)%00%(contents:subject)",
      "refs/heads",
    ]);
    return String(stdout)
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [branch, sha, date, subject] = line.split("\0");
        return { branch, sha, date, subject };
      });
  }

  async log(name: string, ref: string, limit = 50) {
    const { stdout } = await this.git(name, ["log", `--max-count=${limit}`, "--format=%H%x00%an%x00%aI%x00%s", safeRef(ref), "--"]).catch(() => ({ stdout: "" }));
    return String(stdout)
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha, author, date, subject] = line.split("\0");
        return { sha, author, date, subject };
      });
  }

  /** ブランチ名やコミットからコミットの情報を引く。見つからなければ例外 */
  async commit(name: string, ref: string) {
    const { stdout } = await this.git(name, ["log", "-1", "--format=%H%x00%an%x00%s", safeRef(ref), "--"]);
    const [full, author, subject] = String(stdout).trim().split("\0");
    if (!full) throw new RepoError(`${ref} が見つかりません`);
    return { sha: full, author, subject };
  }

  /** ファイルの一覧（ディレクトリをたどった全ファイル） */
  async tree(name: string, ref: string) {
    const { stdout } = await this.git(name, ["ls-tree", "-r", "-l", "--full-tree", "-z", safeRef(ref)]).catch(() => ({ stdout: "" }));
    return String(stdout)
      .split("\0")
      .filter(Boolean)
      .map(parseTreeEntry)
      .filter((f) => f.type === "blob")
      .map(({ path: p, type, size }) => ({ path: p, type, size }));
  }

  /** あるコミットの全ファイルの合計サイズ */
  async treeSize(name: string, ref: string): Promise<number> {
    return (await this.tree(name, ref)).reduce((n, f) => n + f.size, 0);
  }

  async blob(name: string, ref: string, file: string): Promise<{ path: string; size: number; text: string | null; binary: boolean } | null> {
    const clean = safePath(file);
    if (!clean) return null;
    // 1 回の ls-tree で種類・大きさ・オブジェクトを決めてから中身を読む（途中で push されても同じオブジェクトを読む）
    const out = await this.git(name, ["ls-tree", "-l", "-z", "--full-tree", safeRef(ref), "--", clean]).catch(() => null);
    const entry = out ? String(out.stdout).split("\0").filter(Boolean).map(parseTreeEntry)[0] : undefined;
    if (entry?.type !== "blob" || entry.path !== clean) return null;
    if (entry.size > MAX_BLOB) return { path: file, size: entry.size, text: null, binary: true };
    const { stdout } = await this.git(name, ["cat-file", "blob", entry.sha], { encoding: "buffer" });
    const data = stdout as unknown as Buffer;
    const binary = data.includes(0);
    return { path: file, size: entry.size, text: binary ? null : data.toString("utf8"), binary };
  }

  /** あるコミットの 1 ファイルを読む（なければ null）。git push で、全体を取り出す前に wrangler の設定だけを読むため */
  async readFile(name: string, sha: string, file: string): Promise<string | null> {
    const out = await this.git(name, ["cat-file", "blob", `${safeRef(sha)}:${safePath(file)}`]).catch(() => null);
    return out ? String(out.stdout) : null;
  }

  /**
   * あるコミットのファイル一式を、メモリに載せずに dest へ直接書き出す。
   * シンボリックリンクは中身（リンク先の文字列）のファイルとして書く（dest の外を指させないため）
   */
  async checkout(name: string, sha: string, dest: string): Promise<void> {
    const index = path.join(dest, "..", `${path.basename(dest)}.index`);
    try {
      await this.git(name, ["read-tree", safeRef(sha)], { env: { GIT_INDEX_FILE: index } });
      await this.git(name, ["-c", "core.symlinks=false", "--work-tree", dest, "checkout-index", "--all", "--force"], { env: { GIT_INDEX_FILE: index } });
    } finally {
      await fs.rm(index, { force: true });
    }
  }

  /**
   * ファイル一式を、デフォルトブランチの次のコミットとして作る（ブランチはまだ動かさない。動かすのは updateBranch）。
   * 管理画面のファイルのアップロードで、手元にファイルがなくなっても clone で取り出せるようにするため。
   * 中身はアップロードしたものだけにする（前のコミットのファイルは引き継がない）。
   * オブジェクトは一時ディレクトリに作る（push の受け取りと同じく、取り込むと決まるまでリポジトリを大きくしない）。
   * 使わなかったら discardCommit で消す
   */
  async commitFiles(name: string, files: UploadedFile[], options: { message: string; author: string; email: string }): Promise<PendingCommit> {
    const created = !(await this.exists(name));
    if (created) await this.create(name);
    const objects = await fs.mkdtemp(path.join(os.tmpdir(), "kanzume-objects-"));
    const pending: PendingCommit = { name, sha: "", branch: "", parent: null, created, objects };
    const work = await fs.mkdtemp(path.join(os.tmpdir(), "kanzume-commit-"));
    const index = `${work}.index`;
    try {
      pending.branch = await this.defaultBranch(name);
      pending.parent = await this.git(name, ["rev-parse", "--verify", "--quiet", `refs/heads/${safeRef(pending.branch)}^{commit}`])
        .then((r) => String(r.stdout).trim() || null)
        .catch(() => null);
      for (const f of files) {
        const dest = path.join(work, safePath(f.path));
        if (!dest.startsWith(work + path.sep)) continue;
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, f.data);
      }
      const env = {
        GIT_INDEX_FILE: index,
        // 書き込みは一時ディレクトリへ。今あるオブジェクトはリポジトリから読む
        GIT_OBJECT_DIRECTORY: objects,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: path.resolve(this.path(name), "objects"),
        GIT_AUTHOR_NAME: options.author,
        GIT_AUTHOR_EMAIL: options.email,
        GIT_COMMITTER_NAME: "Kanzume",
        GIT_COMMITTER_EMAIL: "kanzume@localhost",
      };
      // -f: アップロードに .gitignore があっても、デプロイしたファイルはすべて入れる
      await this.git(name, ["-C", work, "-c", "core.autocrlf=false", "--work-tree", work, "add", "--all", "--force", "."], { env });
      const tree = String((await this.git(name, ["write-tree"], { env })).stdout).trim();
      pending.sha = String((await this.git(name, ["commit-tree", tree, ...(pending.parent ? ["-p", pending.parent] : []), "-m", options.message], { env })).stdout).trim();
      return pending;
    } catch (err) {
      await this.discardCommit(pending);
      throw err;
    } finally {
      await fs.rm(work, { recursive: true, force: true });
      await fs.rm(index, { force: true });
    }
  }

  /** 使わなかったコミットを消す。そのために作ったリポジトリも消す */
  async discardCommit(pending: PendingCommit): Promise<void> {
    await fs.rm(pending.objects, { recursive: true, force: true });
    if (pending.created) await this.remove(pending.name);
  }

  /**
   * コミットを取り込んで、ブランチを進める。作ったときの親から、その間の push でブランチが動いていたら取り込まない。
   * 容量の上限（push と同じ）を超えるときも取り込まない。どちらの場合も一時オブジェクトは消す
   */
  async updateBranch(pending: PendingCommit): Promise<"ok" | "moved" | "quota"> {
    const { name, branch, sha, parent, objects } = pending;
    try {
      const repoObjects = path.join(this.path(name), "objects");
      if (this.quotaBytes > 0 && (await dirSize(repoObjects)) + (await dirSize(objects)) > this.quotaBytes) return "quota";
      const head = await this.git(name, ["rev-parse", "--verify", "--quiet", `refs/heads/${safeRef(branch)}^{commit}`])
        .then((r) => String(r.stdout).trim() || null)
        .catch(() => null);
      if (head !== parent) return "moved";
      // 一時オブジェクトをリポジトリに移してから、ブランチを進める（進めた時点で、指す先がすべてそろっているように）
      await moveObjects(objects, repoObjects);
      const ok = await this.git(name, ["update-ref", "-m", "kanzume: upload", `refs/heads/${safeRef(branch)}`, sha, parent ?? "0".repeat(40)])
        .then(() => true)
        .catch(() => false);
      if (ok) this.onChange?.();
      return ok ? "ok" : "moved";
    } finally {
      await fs.rm(objects, { recursive: true, force: true });
    }
  }
}

/** アップロードから作ったまだ取り込んでいないコミット */
export interface PendingCommit {
  name: string;
  sha: string;
  branch: string;
  parent: string | null;
  /** このアップロードのためにリポジトリを作ったか */
  created: boolean;
  /** オブジェクトを作った一時ディレクトリ */
  objects: string;
}

/**
 * 一時ディレクトリに作ったオブジェクトを移す。ルーズオブジェクト（xx/yyyy…）と、大きなファイルで git が作る pack
 * （pack/*.pack と *.idx。pack を先に移し、読む側が idx だけを見ないように）。リポジトリにすでにあるものはそのまま
 */
async function moveObjects(from: string, to: string): Promise<void> {
  const move = async (src: string, dest: string) => {
    if (await fs.stat(dest).then(() => true, () => false)) return;
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rename(src, dest).catch(async (err: NodeJS.ErrnoException) => {
      // 一時ディレクトリが別のファイルシステムにあるとき
      if (err.code !== "EXDEV") throw err;
      await fs.copyFile(src, `${dest}.tmp`);
      await fs.rename(`${dest}.tmp`, dest);
    });
  };
  for (const dir of await fs.readdir(from)) {
    if (/^[0-9a-f]{2}$/.test(dir)) {
      for (const file of await fs.readdir(path.join(from, dir))) await move(path.join(from, dir, file), path.join(to, dir, file));
    } else if (dir === "pack") {
      const files = (await fs.readdir(path.join(from, "pack"))).filter((f) => /^pack-[0-9a-f]+\.(pack|idx|rev)$/.test(f));
      const order = (f: string) => (f.endsWith(".pack") ? 0 : f.endsWith(".rev") ? 1 : 2);
      for (const file of files.sort((x, y) => order(x) - order(y))) await move(path.join(from, "pack", file), path.join(to, "pack", file));
    }
  }
}
