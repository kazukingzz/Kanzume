import path from "node:path";
import { gunzipSync } from "node:zlib";
import type { UploadedFile } from "../store.ts";
import { UserFacingError } from "../errors.ts";

export class TarError extends UserFacingError {}

const BLOCK = 512;
const MAX_FILES = 20_000;

function readString(buf: Buffer, offset: number, length: number): string {
  const end = buf.indexOf(0, offset);
  return buf.toString("utf8", offset, end === -1 || end > offset + length ? offset + length : end);
}

function readOctal(buf: Buffer, offset: number, length: number): number {
  const s = readString(buf, offset, length).trim();
  return s ? parseInt(s, 8) : 0;
}

function parsePax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    if (space === -1) break;
    const len = Number(data.toString("utf8", i, space));
    // 長さは「長さ 空白 キー=値 改行」全体。0 以下や範囲外は壊れているので読むのをやめる（負の値で戻ると終わらない）
    if (!Number.isSafeInteger(len) || len <= space - i + 1 || i + len > data.length) break;
    const record = data.toString("utf8", space + 1, i + len - 1);
    const eq = record.indexOf("=");
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    i += len;
  }
  return out;
}

export function safePath(name: string): string | null {
  const normalized = path.posix
    .normalize(name.replace(/\\/g, "/"))
    .replace(/^(\.\/)+/, "")
    .replace(/\/+$/, "");
  if (!normalized || normalized === ".") return null;
  if (normalized.startsWith("/") || normalized.split("/").includes("..")) throw new TarError(`不正なパスです: ${name}`);
  return normalized;
}

export function readTar(buf: Buffer, options: { skipLinks?: boolean } = {}): UploadedFile[] {
  const files: UploadedFile[] = [];
  let offset = 0;
  let longName: string | null = null;
  let pax: Record<string, string> = {};

  while (offset + BLOCK <= buf.length) {
    const header = buf.subarray(offset, offset + BLOCK);
    if (header.every((b) => b === 0)) break;

    let checksum = 0;
    for (let i = 0; i < BLOCK; i++) checksum += i >= 148 && i < 156 ? 0x20 : header[i];
    if (checksum !== readOctal(header, 148, 8)) throw new TarError("tar のヘッダが壊れています");

    const size = readOctal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 0x30);
    const dataStart = offset + BLOCK;
    const data = buf.subarray(dataStart, dataStart + size);
    if (data.length !== size) throw new TarError("tar が途中で切れています");
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (type === "x") {
      pax = parsePax(data);
      continue;
    }
    if (type === "L") {
      longName = readString(data, 0, data.length);
      continue;
    }
    if (type === "g") continue;

    const prefix = header.toString("utf8", 257, 263).startsWith("ustar") ? readString(header, 345, 155) : "";
    const name = pax.path ?? longName ?? (prefix ? `${prefix}/${readString(header, 0, 100)}` : readString(header, 0, 100));
    longName = null;
    pax = {};

    if (type === "5") continue;
    if (options.skipLinks && (type === "1" || type === "2")) continue;
    if (type !== "0" && type !== "7") throw new TarError(`通常ファイル以外は含められません: ${name}`);

    const filePath = safePath(name);
    if (!filePath) continue;
    if (files.length >= MAX_FILES) throw new TarError(`ファイル数が多すぎます（上限 ${MAX_FILES}）`);
    files.push({ path: filePath, data });
  }
  return files;
}

/** 展開後の大きさの上限（アップロードの上限の何倍か） */
export const EXTRACT_RATIO = 4;

/**
 * tar.gz を展開する。展開後が maxBytes × EXTRACT_RATIO を超えたら 413、壊れていたら 400（どちらも UserFacingError）。
 * skipLinks: シンボリックリンクとハードリンクは飛ばす（アップロードと GitHub のリポジトリ。Actions の tar はリンクを含めない）
 */
export function extractTarGz(buf: Buffer, maxBytes: number, options: { skipLinks?: boolean } = {}): UploadedFile[] {
  let tar: Buffer;
  try {
    tar = gunzipSync(buf, { maxOutputLength: maxBytes * EXTRACT_RATIO });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ERR_BUFFER_TOO_LARGE") throw new UserFacingError("展開後のファイルが大きすぎます", 413);
    throw new TarError("tar.gz を展開できません");
  }
  return readTar(tar, options);
}
