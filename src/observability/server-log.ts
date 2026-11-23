/**
 * 本体（管理画面・デプロイ・配信を受け持つプロセス）の console 出力を <data>/logs/server.log にも書く。
 * Worker のログ（events.sqlite）と違ってバックアップに含め、復元したあとも落ちる前のログを追えるようにする。
 * 大きくなったら server.log.1 に回し、2 世代だけ残す
 */
import fs from "node:fs";
import path from "node:path";
import { format } from "node:util";
import { LOGS_DIR, SERVER_LOG } from "../layout.ts";

const LEVELS = ["log", "info", "warn", "error"] as const;
type Level = (typeof LEVELS)[number];

export const serverLogFile = (dataDir: string) => path.join(dataDir, LOGS_DIR, SERVER_LOG);

/** 1 行（1 回の出力）の長さの上限。訪問者が送った値などを含む長い出力で、ログがすぐに回ってしまわないように */
const MAX_LINE = 8 * 1024;
/** 復元が終わるまでメモリにためる行数の上限 */
const MAX_PENDING = 1000;

export class ServerLog {
  #file: string | null = null;
  // 復元が終わるまで /data に書けない（先に書くと復元したファイルとぶつかる）ので、それまではメモリにためる
  #pending: string[] = [];
  readonly maxBytes: number;
  readonly maxLinesPerSecond: number;
  // 1 秒ごとに数え直す。超えた分は書かずに数え、次の秒の最初に「N 行を省略」と書く
  // （同期で書くので、大量の出力を全部書くと本体が止まり、残したい古い行もすぐに回って消える）
  #window = 0;
  #lines = 0;
  #dropped = 0;

  constructor(maxBytes = 1024 * 1024, maxLinesPerSecond = 100) {
    this.maxBytes = maxBytes;
    this.maxLinesPerSecond = maxLinesPerSecond;
  }

  /** console.log / info / warn / error と、落ちる直前の例外を取り込む。元の出力（標準出力・標準エラー）はそのまま */
  capture(): this {
    for (const level of LEVELS) {
      const original = console[level].bind(console);
      console[level] = (...args: unknown[]) => {
        original(...args);
        this.write(level, format(...args));
      };
    }
    // 例外で落ちるときの出力は console を通らない。monitor は落ちる動きを変えない
    process.on("uncaughtExceptionMonitor", (err, origin) => this.write("error", `[kanzume] ${origin}: ${format(err)}`, true));
    return this;
  }

  /** ここから先はファイルに書く。ためていた分も書き出す */
  open(dataDir: string): void {
    const file = serverLogFile(dataDir);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.#file = file;
    const pending = this.#pending;
    this.#pending = [];
    for (const line of pending) this.#append(line);
  }

  /** force は落ちる直前の例外など、数の上限にかかわらず書くもの */
  write(level: Level, message: string, force = false, now = Date.now()): void {
    const window = Math.floor(now / 1000);
    if (window !== this.#window) {
      this.#window = window;
      this.#lines = 0;
      if (this.#dropped) {
        const dropped = this.#dropped;
        this.#dropped = 0;
        this.#emit(now, "warn", `[kanzume] ログが多すぎるため ${dropped} 行を省略しました（1 秒あたり ${this.maxLinesPerSecond} 行まで）`);
      }
    }
    if (!force && ++this.#lines > this.maxLinesPerSecond) {
      this.#dropped++;
      return;
    }
    const text = message.length > MAX_LINE ? `${message.slice(0, MAX_LINE)}…（${message.length - MAX_LINE} 文字を省略）` : message;
    this.#emit(now, level, text);
  }

  #emit(now: number, level: Level, message: string): void {
    const line = `${new Date(now).toISOString()} ${level.toUpperCase().padEnd(5)} ${message.replace(/\n/g, "\n    ")}\n`;
    if (this.#file) this.#append(line);
    else if (this.#pending.length < MAX_PENDING) this.#pending.push(line);
  }

  #append(line: string): void {
    const file = this.#file as string;
    try {
      // 落ちる直前の行を取りこぼさないように同期で書く（本体のログはまれなので重くならない）
      const size = fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0;
      if (size > 0 && size + line.length > this.maxBytes) fs.renameSync(file, `${file}.1`);
      fs.appendFileSync(file, line, { mode: 0o600 });
    } catch {
      // ログが書けなくても本体は止めない（ディスクがいっぱいなど）
    }
  }
}

/** 新しい方から maxLines 行（古い世代もまたいで読む）。ファイルがなければ空 */
export function readServerLog(dataDir: string, maxLines = 1000): { lines: string[]; bytes: number } {
  const file = serverLogFile(dataDir);
  const read = (f: string) => {
    try {
      return fs.readFileSync(f, "utf8");
    } catch {
      return "";
    }
  };
  const text = read(`${file}.1`) + read(file);
  const lines = text.split("\n").filter(Boolean);
  return { lines: lines.slice(-maxLines), bytes: Buffer.byteLength(text) };
}
