/** サイトのデータ: データベース（KV）とストレージ（R2）の中身を見る・変える */
import { R2_BUCKET_NAME } from "../../bindings/r2.ts";
import { BINDING_NAME } from "../../deploy/wrangler.ts";
import { tooLarge } from "../../errors.ts";
import { pipeline } from "node:stream/promises";
import { readBody } from "../../http.ts";
import { type Ctx, fail, type Route } from "../context.ts";
import { kvDelete, kvKeys, kvNamespaces, kvPut, kvValue, r2Buckets, r2Delete, r2Download, r2List, r2Preview, r2Put } from "../data.ts";

/** KV / R2 の入力の誤り（キーが長すぎる・範囲がおかしいなど）は、バインディングが TypeError / RangeError で知らせる */
async function asInputError<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof TypeError || err instanceof RangeError) return fail(400, err.message);
    throw err;
  }
}

function namespaceOf(ctx: Ctx): string {
  const ns = ctx.params.ns;
  return BINDING_NAME.test(ns) ? ns : fail(400, "KV の名前空間の名前が不正です");
}

/** バケット名はファイルのディレクトリ名になるので、wrangler と同じ規則で確かめる（../ などでサイトの外に出させない） */
function bucketOf(ctx: Ctx): string {
  const name = ctx.params.bucket;
  return R2_BUCKET_NAME.test(name) ? name : fail(400, "バケット名が不正です");
}

const key = (ctx: Ctx) => ctx.query.get("key") ?? "";

export const dataRoutes: Route[] = [
  {
    method: "GET",
    path: "/api/sites/:site/kv",
    auth: "site",
    handle: (ctx) => ({ namespaces: kvNamespaces(ctx.site.store.siteDir, ctx.site.release) }),
  },
  {
    method: "GET",
    path: "/api/sites/:site/kv/:ns/keys",
    auth: "site",
    handle: (ctx) => kvKeys(ctx.site.store.siteDir, namespaceOf(ctx), ctx.query.get("prefix") ?? "", ctx.query.get("after") ?? ""),
  },
  {
    method: "GET",
    path: "/api/sites/:site/kv/:ns/value",
    auth: "site",
    handle: (ctx) => kvValue(ctx.site.store.siteDir, namespaceOf(ctx), key(ctx)) ?? fail(404, "キーが見つかりません"),
  },
  {
    method: "PUT",
    path: "/api/sites/:site/kv/:ns/value",
    auth: "site",
    handle: async (ctx) => {
      const ns = namespaceOf(ctx);
      const body = await ctx.body(26 * 1024 * 1024);
      const ttl = body.expirationTtl === null || body.expirationTtl === undefined || body.expirationTtl === "" ? undefined : Number(body.expirationTtl);
      await asInputError(() =>
        kvPut(ctx.site.store.siteDir, ns, String(body.key ?? ""), String(body.value ?? ""), { expirationTtl: ttl, metadata: body.metadata ?? undefined }),
      );
      return { ok: true };
    },
  },
  {
    method: "DELETE",
    path: "/api/sites/:site/kv/:ns/value",
    auth: "site",
    handle: async (ctx) => {
      const ns = namespaceOf(ctx);
      await asInputError(() => kvDelete(ctx.site.store.siteDir, ns, key(ctx)));
      return { ok: true };
    },
  },
  {
    method: "GET",
    path: "/api/sites/:site/r2",
    auth: "site",
    handle: (ctx) => ({ buckets: r2Buckets(ctx.site.store.siteDir, ctx.site.release) }),
  },
  {
    method: "GET",
    path: "/api/sites/:site/r2/:bucket/objects",
    auth: "site",
    handle: (ctx) => {
      const name = bucketOf(ctx);
      return asInputError(async () => r2List(ctx.site.store.siteDir, name, ctx.query.get("prefix") ?? "", ctx.query.get("cursor") || undefined));
    },
  },
  {
    method: "GET",
    path: "/api/sites/:site/r2/:bucket/preview",
    auth: "site",
    handle: (ctx) => asInputError(async () => (await r2Preview(ctx.site.store.siteDir, bucketOf(ctx), key(ctx))) ?? fail(404, "オブジェクトが見つかりません")),
  },
  {
    method: "GET",
    path: "/api/sites/:site/r2/:bucket/object",
    auth: "site",
    handle: (ctx) =>
      asInputError(async () => {
        const obj = await r2Download(ctx.site.store.siteDir, bucketOf(ctx), key(ctx));
        if (!obj) return fail(404, "オブジェクトが見つかりません");
        // 管理画面と同じオリジンで開かれないよう、必ずダウンロードにする
        const filename = encodeURIComponent(key(ctx).split("/").pop() || "object");
        ctx.res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": String(obj.size),
          "content-disposition": `attachment; filename*=UTF-8''${filename}`,
          "x-content-type-options": "nosniff",
          "cache-control": "no-store",
        });
        if (!obj.stream) return void ctx.res.end();
        // 受け手が遅くても読み進めない（pipeline が書き込みの詰まりを待つ）。途中で切れたら接続ごと閉じる
        await pipeline(obj.stream, ctx.res).catch(() => ctx.res.destroy());
      }),
  },
  {
    method: "PUT",
    path: "/api/sites/:site/r2/:bucket/object",
    auth: "site",
    handle: (ctx) =>
      asInputError(async () => {
        const bucket = bucketOf(ctx);
        const max = ctx.deps.config.maxUploadBytes;
        const body = await readBody(ctx.req, max);
        if (!body) throw tooLarge(max);
        const contentType = String(ctx.req.headers["x-object-content-type"] ?? "") || undefined;
        await r2Put(ctx.site.store.siteDir, bucket, key(ctx), body, contentType);
        return { ok: true };
      }),
  },
  {
    method: "DELETE",
    path: "/api/sites/:site/r2/:bucket/object",
    auth: "site",
    handle: (ctx) =>
      asInputError(async () => {
        await r2Delete(ctx.site.store.siteDir, bucketOf(ctx), key(ctx));
        return { ok: true };
      }),
  },
];
