/** Kanzume が代わりに返すファイル（robots.txt・security.txt）の設定。全体の既定は管理者、サイトごとの上書きはそのサイトを扱える人 */
import fs from "node:fs";
import path from "node:path";
import { assetsDir } from "../../bindings/assets.ts";
import {
  defaultRobots,
  defaultSecurityTxt,
  type ManagedFiles,
  type ManagedKind,
  MANAGED_FILE_PATH,
  normalizeManagedFiles,
  previewManagedFile,
  resolveManagedFile,
  type SiteManagedFiles,
} from "../../managed-files.ts";
import type { Release } from "../../store.ts";
import { type Ctx, fail, type Route } from "../context.ts";

const KINDS: ManagedKind[] = ["robots", "securityTxt"];

/** 全体の既定（未設定のものは、フォームの初期値として既定の形を返す）と、今の設定で返る中身 */
function globalView(files: ManagedFiles) {
  return {
    robots: files.robots ?? defaultRobots(),
    securityTxt: files.securityTxt ?? defaultSecurityTxt(),
    preview: { robots: resolveManagedFile("robots", files, undefined), securityTxt: resolveManagedFile("securityTxt", files, undefined) },
  };
}

/** リリースに、そのファイルがあるか（あれば Kanzume は何もせず、サイトのものを返す） */
function hasOwnFile(release: Release | undefined, kind: ManagedKind): boolean {
  if (!release?.manifest.assets) return false;
  try {
    return fs.statSync(path.join(assetsDir(release), MANAGED_FILE_PATH[kind])).isFile();
  } catch {
    return false;
  }
}

function siteView(ctx: Ctx) {
  const { state, sites } = ctx.deps;
  const { name, release } = ctx.site;
  const global = state.managedFiles;
  const site: SiteManagedFiles = sites.settings(name).managedFiles ?? {};
  const entry = (kind: ManagedKind) => ({
    path: MANAGED_FILE_PATH[kind],
    mode: site[kind]?.mode ?? "default",
    // 「このサイトだけ変える」のフォームに出す設定（なければ全体の既定から始める）
    config: site[kind]?.config ?? global[kind] ?? (kind === "robots" ? defaultRobots() : defaultSecurityTxt()),
    // 全体の既定が有効か（「全体の既定に従う」を選んだときに返るか）
    defaultEnabled: global[kind]?.enabled === true,
    // サイトのファイルにあれば、そちらを返す
    ownFile: hasOwnFile(release, kind),
    // Kanzume が返す中身（返さないなら null）
    content: resolveManagedFile(kind, global, site),
  });
  return { robots: entry("robots"), securityTxt: entry("securityTxt") };
}

export const managedFileRoutes: Route[] = [
  {
    method: "GET",
    path: "/api/managed-files",
    auth: "admin",
    handle: (ctx) => globalView(ctx.deps.state.managedFiles),
  },
  {
    method: "PUT",
    path: "/api/managed-files",
    auth: "admin",
    handle: async (ctx) => {
      const { state } = ctx.deps;
      return globalView(await state.setManagedFiles(normalizeManagedFiles(await ctx.body(), state.managedFiles)));
    },
  },
  {
    // 保存する前の入力から、返す中身を作る（確かめ方は保存と同じ）
    method: "POST",
    path: "/api/managed-files/preview",
    auth: "user",
    handle: async (ctx) => {
      const body = await ctx.body();
      const kind = KINDS.find((k) => k === body.kind) ?? fail(400, "kind は robots か securityTxt にしてください");
      return { content: previewManagedFile(kind, body.config) };
    },
  },
  {
    method: "GET",
    path: "/api/sites/:site/managed-files",
    auth: "site",
    handle: siteView,
  },
  {
    method: "PUT",
    path: "/api/sites/:site/managed-files",
    auth: "site",
    handle: async (ctx) => {
      await ctx.deps.sites.updateSettings(ctx.site.name, { managedFiles: await ctx.body() });
      return siteView(ctx);
    },
  },
];
