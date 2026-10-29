import { Buffer } from "node:buffer";

interface Env {
  GREETING: string;
  KV: KVNamespace;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/hello") {
      return Response.json({ message: env.GREETING });
    }

    if (url.pathname === "/api/counter") {
      const count = Number((await env.KV.get("count")) ?? "0") + 1;
      ctx.waitUntil(env.KV.put("count", String(count)));
      return Response.json({ count });
    }

    if (url.pathname.startsWith("/api/files/")) {
      const key = decodeURIComponent(url.pathname.slice("/api/files/".length));
      if (request.method === "PUT") {
        const object = await env.BUCKET.put(key, request.body, {
          httpMetadata: { contentType: request.headers.get("content-type") ?? "application/octet-stream" },
        });
        return Response.json({ key: object.key, size: object.size, etag: object.etag });
      }
      const object = await env.BUCKET.get(key);
      if (!object) return new Response("Not Found", { status: 404 });
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      // 保存した content-type のまま表示させないのは、誰でもアップロードできる HTML がサイトと同じオリジンで動いてしまうため
      headers.set("content-disposition", "attachment");
      headers.set("x-content-type-options", "nosniff");
      return new Response(object.body, { headers });
    }

    if (url.pathname === "/api/base64") {
      return new Response(Buffer.from(await request.text()).toString("base64"));
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
