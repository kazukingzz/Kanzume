/** サイトのコード（デプロイしたファイル）と可観測性（メトリクス・イベント） */
import { type Ctx, fail, type Route } from "../context.ts";
import { type FileGroup, listFiles, readFile } from "../files.ts";

const FILE_GROUPS: FileGroup[] = ["source", "config", "worker", "assets"];

function releaseOf(ctx: Ctx) {
  return ctx.site.release ?? fail(404, "まだデプロイされていません");
}

export const observabilityRoutes: Route[] = [
  {
    method: "GET",
    path: "/api/sites/:site/files",
    auth: "site",
    handle: (ctx) => {
      const release = releaseOf(ctx);
      return { release: release.id, groups: listFiles(release) };
    },
  },
  {
    method: "GET",
    path: "/api/sites/:site/file",
    auth: "site",
    handle: (ctx) => {
      const release = releaseOf(ctx);
      const group = ctx.query.get("group") as FileGroup;
      if (!FILE_GROUPS.includes(group)) return fail(404, "ファイルが見つかりません");
      return readFile(release, group, ctx.query.get("path") ?? "") ?? fail(404, "ファイルが見つかりません");
    },
  },
  {
    method: "GET",
    path: "/api/sites/:site/metrics",
    auth: "site",
    handle: (ctx) => ctx.deps.observability.metrics(ctx.site.name, ctx.query.get("range") ?? "24h"),
  },
  {
    method: "GET",
    path: "/api/sites/:site/events",
    auth: "site",
    handle: (ctx) => {
      const q = ctx.query;
      const num = (k: string) => (q.get(k) ? Number(q.get(k)) : undefined);
      const result = q.get("result");
      const kind = q.get("kind");
      return {
        events: ctx.deps.observability.events(ctx.site.name, {
          before: num("before"),
          after: num("after"),
          from: num("from"),
          limit: num("limit"),
          result: result === "ok" || result === "error" ? result : undefined,
          kind: kind === "worker" || kind === "asset" ? kind : undefined,
          q: q.get("q")?.trim() || undefined,
        }),
      };
    },
  },
  {
    method: "GET",
    path: "/api/sites/:site/events/:id",
    auth: "site",
    handle: (ctx) => {
      const id = Number(ctx.params.id);
      if (!Number.isSafeInteger(id)) return fail(404, "イベントが見つかりません");
      return ctx.deps.observability.event(ctx.site.name, id) ?? fail(404, "イベントが見つかりません");
    },
  },
];
