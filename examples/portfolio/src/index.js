// ポートフォリオのサンプル。静的ファイルは assets から配信し、/api/* だけ Worker で処理する
const WORKS = ["tide", "kumo", "hako", "noren"];
const MESSAGE_TTL = 60 * 60 * 24 * 30; // お問い合わせは 30 日で消す

const json = (body, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

async function likes(env) {
  const counts = await Promise.all(WORKS.map(async (slug) => [slug, Number((await env.KV.get(`likes:${slug}`)) ?? 0)]));
  return Object.fromEntries(counts);
}

async function contact(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "JSON で送ってください" }, 400);
  }
  const name = String(body?.name ?? "").trim();
  const email = String(body?.email ?? "").trim();
  const message = String(body?.message ?? "").trim();
  if (!name || name.length > 60) return json({ error: "お名前は 60 文字以内で入力してください" }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) return json({ error: "メールアドレスを確認してください" }, 400);
  if (!message || message.length > 2000) return json({ error: "メッセージは 2000 文字以内で入力してください" }, 400);
  const key = `message:${new Date().toISOString()}:${crypto.randomUUID().slice(0, 8)}`;
  await env.KV.put(key, JSON.stringify({ name, email, message }), { expirationTtl: MESSAGE_TTL });
  console.log("お問い合わせを受け付けました", { key, name });
  return json({ ok: true });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/likes" && request.method === "GET") return json(await likes(env));

    const like = /^\/api\/likes\/([a-z0-9-]+)$/.exec(url.pathname);
    if (like && request.method === "POST") {
      const slug = like[1];
      if (!WORKS.includes(slug)) return json({ error: "作品が見つかりません" }, 404);
      const count = Number((await env.KV.get(`likes:${slug}`)) ?? 0) + 1;
      ctx.waitUntil(env.KV.put(`likes:${slug}`, String(count)));
      return json({ slug, count });
    }

    if (url.pathname === "/api/contact" && request.method === "POST") return contact(request, env);

    if (url.pathname.startsWith("/api/")) return json({ error: "Not Found" }, 404);
    return env.ASSETS.fetch(request);
  },
};
