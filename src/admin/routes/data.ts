/** サイトのデータ: データベース（KV）とストレージ（R2）の中身を見る・変える */
import { R2_BUCKET_NAME } from "../../bindings/r2.ts";
import { BINDING_NAME } from "../../deploy/wrangler.ts";
import { tooLarge } from "../../errors.ts";
import { readBody } from "../../http.ts";
import { type Ctx, fail, type Route } from "../context.ts";
import { asText, kvDelete, kvKeys, kvNamespaces, kvPut, kvValue, PREVIEW_BYTES, r2Bucket, r2Buckets, r2List } from "../data.ts";

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
function bucketOf(ctx: Ctx) {
  const name = ctx.params.bucket;
  if (!R2_BUCKET_NAME.test(name)) return fail(400, "バケット名が不正です");
  return { name, bucket: r2Bucket(ctx.site.store.siteDir, name) };
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
      const { name } = bucketOf(ctx);
      return asInputError(() => r2List(ctx.site.store.siteDir, name, ctx.query.get("prefix") ?? "", ctx.query.get("cursor") || undefined));
    },
  },
  {
    method: "GET",
    path: "/api/sites/:site/r2/:bucket/preview",
    auth: "site",
    handle: (ctx) =>
      asInputError(async () => {
        const { bucket } = bucketOf(ctx);
        const obj = (await bucket.get(key(ctx), { range: { offset: 0, length: PREVIEW_BYTES } })) as { arrayBuffer?: () => Promise<ArrayBuffer> } | null;
        if (!obj?.arrayBuffer) return fail(404, "オブジェクトが見つかりません");
        const size = (await bucket.head(key(ctx)))?.size ?? 0;
        return { text: asText(new Uint8Array(await obj.arrayBuffer()), size > PREVIEW_BYTES), size, truncated: size > PREVIEW_BYTES };
      }),
  },
  {
    method: "GET",
    path: "/api/sites/:site/r2/:bucket/object",
    auth: "site",
    handle: (ctx) =>
      asInputError(async () => {
        const { bucket } = bucketOf(ctx);
        const obj = (await bucket.get(key(ctx))) as { size: number; body?: ReadableStream<Uint8Array> } | null;
        if (!obj?.body) return fail(404, "オブジェクトが見つかりません");
        // 管理画面と同じオリジンで開かれないよう、必ずダウンロードにする
        const filename = encodeURIComponent(key(ctx).split("/").pop() || "object");
        ctx.res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": String(obj.size),
          "content-disposition": `attachment; filename*=UTF-8''${filename}`,
          "x-content-type-options": "nosniff",
          "cache-control": "no-store",
        });
        for await (const chunk of obj.body) ctx.res.write(chunk);
        ctx.res.end();
      }),
  },
  {
    method: "PUT",
    path: "/api/sites/:site/r2/:bucket/object",
    auth: "site",
    handle: (ctx) =>
      asInputError(async () => {
        const { bucket } = bucketOf(ctx);
        const max = ctx.deps.config.maxUploadBytes;
        const body = await readBody(ctx.req, max);
        if (!body) throw tooLarge(max);
        const contentType = String(ctx.req.headers["x-object-content-type"] ?? "") || undefined;
        await bucket.put(key(ctx), body, { httpMetadata: contentType ? { contentType } : undefined });
        return { ok: true };
      }),
  },
  {
    method: "DELETE",
    path: "/api/sites/:site/r2/:bucket/object",
    auth: "site",
    handle: (ctx) =>
      asInputError(async () => {
        await bucketOf(ctx).bucket.delete(key(ctx));
        return { ok: true };
      }),
  },
];
