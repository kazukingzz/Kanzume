import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { PROJECT_NAME } from "../store.ts";

const run = promisify(execFile);
const MAX_BLOB = 1024 * 1024;
export const ZERO_SHA = "0000000000000000000000000000000000000000";

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

/**
 * Kanzume が持つ Git のリモートリポジトリ（bare）。push は `git http-backend` が受け、読み取りは git コマンドで行う。
 * 置き場所は `<dataDir>/repos/<name>.git`。
 */
export class Repos {
  readonly dir: string;
  readonly maxInputBytes: number;

  constructor(dataDir: string, maxInputBytes: number) {
    this.dir = path.join(dataDir, "repos");
    this.maxInputBytes = maxInputBytes;
  }

  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
  }

  path(name: string): string {
    return path.join(this.dir, `${name}.git`);
  }

  git(name: string, args: string[], options: { maxBuffer?: number; encoding?: "buffer" } = {}) {
    return run("git", ["--git-dir", this.path(name), ...args], {
      maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
      encoding: (options.encoding ?? "utf8") as BufferEncoding,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
    });
  }

  async exists(name: string): Promise<boolean> {
    if (!PROJECT_NAME.test(name)) return false;
    return fs
      .stat(path.join(this.path(name), "HEAD"))
      .then(() => true)
      .catch(() => false);
  }

  async names(): Promise<string[]> {
    const entries = await fs.readdir(this.dir).catch(() => [] as string[]);
    return entries
      .filter((e) => e.endsWith(".git"))
      .map((e) => e.slice(0, -4))
      .filter((n) => PROJECT_NAME.test(n))
      .sort();
  }

  async create(name: string): Promise<void> {
    if (!PROJECT_NAME.test(name)) throw new RepoError("名前は英小文字・数字・ハイフンで 63 文字以内にしてください");
    if (await this.exists(name)) throw new RepoError("同じ名前のリポジトリがあります");
    await run("git", ["init", "--quiet", "--bare", "--initial-branch=main", this.path(name)]);
    await this.git(name, ["config", "http.receivepack", "true"]);
  }

  async remove(name: string): Promise<void> {
    if (!(await this.exists(name))) return;
    await fs.rm(this.path(name), { recursive: true, force: true });
  }

  async defaultBranch(name: string): Promise<string> {
    const { stdout } = await this.git(name, ["symbolic-ref", "--short", "HEAD"]).catch(() => ({ stdout: "main" }));
    return String(stdout).trim() || "main";
  }

  async summary(name: string): Promise<RepoSummary> {
    const [defaultBranch, { stdout }, { stdout: counts }] = await Promise.all([
      this.defaultBranch(name),
      this.git(name, ["for-each-ref", "--sort=-committerdate", "--count=1", "--format=%(committerdate:iso-strict)", "refs/heads"]),
      this.git(name, ["count-objects", "-v"]),
    ]);
    // ディレクトリをたどらずに、オブジェクトの大きさ（KiB）だけを足す
    const kib = (key: string) => Number(new RegExp(`^${key}: (\\d+)$`, "m").exec(String(counts))?.[1] ?? 0);
    return { name, defaultBranch, lastPush: String(stdout).trim() || null, size: (kib("size") + kib("size-pack")) * 1024 };
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

  async resolve(name: string, ref: string): Promise<string | null> {
    const out = await this.git(name, ["rev-parse", "--verify", "--quiet", `${safeRef(ref)}^{commit}`]).catch(() => null);
    return out ? String(out.stdout).trim() : null;
  }

  async commit(name: string, sha: string) {
    const { stdout } = await this.git(name, ["log", "-1", "--format=%H%x00%an%x00%s", safeRef(sha), "--"]);
    const [full, author, subject] = String(stdout).trim().split("\0");
    return { sha: full, author, subject };
  }

  /** ファイルの一覧（ディレクトリをたどった全ファイル） */
  async tree(name: string, ref: string) {
    const { stdout } = await this.git(name, ["ls-tree", "-r", "-l", "--full-tree", "-z", safeRef(ref)]).catch(() => ({ stdout: "" }));
    return String(stdout)
      .split("\0")
      .filter(Boolean)
      .map((entry) => {
        const [meta, file] = entry.split("\t");
        const [, type, , size] = meta.split(/\s+/);
        return { path: file, type, size: Number(size) || 0 };
      })
      .filter((f) => f.type === "blob");
  }

  async blob(name: string, ref: string, file: string): Promise<{ path: string; size: number; text: string | null; binary: boolean } | null> {
    const clean = safePath(file);
    if (!clean) return null;
    const spec = `${safeRef(ref)}:${clean}`;
    const type = await this.git(name, ["cat-file", "-t", spec]).catch(() => null);
    if (!type || String(type.stdout).trim() !== "blob") return null;
    const out = await this.git(name, ["cat-file", "-s", spec]).catch(() => null);
    const size = out ? Number(String(out.stdout).trim()) : NaN;
    if (!Number.isFinite(size)) return null;
    if (size > MAX_BLOB) return { path: file, size, text: null, binary: true };
    const { stdout } = await this.git(name, ["cat-file", "blob", spec], { encoding: "buffer" });
    const data = stdout as unknown as Buffer;
    const binary = data.includes(0);
    return { path: file, size, text: binary ? null : data.toString("utf8"), binary };
  }

  /** あるコミットのファイル一式を tar で取り出す */
  async archive(name: string, sha: string): Promise<Buffer> {
    const { stdout } = await this.git(name, ["archive", "--format=tar", safeRef(sha)], { encoding: "buffer", maxBuffer: this.maxInputBytes * 4 });
    return stdout as unknown as Buffer;
  }
}
