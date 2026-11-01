// ポートフォリオのサンプル。静的ファイルは assets から配信し、/api/* だけ Worker で処理する
const WORKS = ["tide", "kumo", "hako", "noren"];
const MESSAGE_TTL = 60 * 60 * 24 * 30; // お問い合わせは 30 日で消す
const MAX_MESSAGES = 200; // 誰でも送れるので、保存する件数に上限を付ける
const RATE_LIMIT = 5; // 同じ接続元から 1 時間に送れる件数

const json = (body, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

// KV には数を足す操作がないので、1 件ずつ別のキーに書いて件数を数える（同時に書いても数え漏れない）
async function count(env, prefix, stopAt = Infinity) {
  let n = 0;
  let cursor;
  do {
    const page = await env.KV.list({ prefix, cursor });
    n += page.keys.length;
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && n < stopAt);
  return n;
}

const add = (env, prefix, options) => env.KV.put(`${prefix}${Date.now().toString(36)}-${crypto.randomUUID()}`, "1", options);

async function likes(env) {
  return Object.fromEntries(await Promise.all(WORKS.map(async (slug) => [slug, await count(env, `likes:${slug}:`)])));
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

  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const rate = `rate:${ip}:${Math.floor(Date.now() / 3_600_000)}:`;
  if ((await count(env, rate, RATE_LIMIT)) >= RATE_LIMIT) return json({ error: "送信が多すぎます。しばらく待ってからもう一度お試しください" }, 429);
  if ((await count(env, "message:", MAX_MESSAGES)) >= MAX_MESSAGES) return json({ error: "いまは受け付けを止めています" }, 503);
  await add(env, rate, { expirationTtl: 3600 });

  const key = `message:${new Date().toISOString()}:${crypto.randomUUID().slice(0, 8)}`;
  await env.KV.put(key, JSON.stringify({ name, email, message }), { expirationTtl: MESSAGE_TTL });
  // 名前やメールアドレスはログ（可観測性）に残さない
  console.log("お問い合わせを受け付けました", { key });
  return json({ ok: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/likes" && request.method === "GET") return json(await likes(env));

    const like = /^\/api\/likes\/([a-z0-9-]+)$/.exec(url.pathname);
    if (like && request.method === "POST") {
      const slug = like[1];
      if (!WORKS.includes(slug)) return json({ error: "作品が見つかりません" }, 404);
      await add(env, `likes:${slug}:`);
      return json({ slug, count: await count(env, `likes:${slug}:`) });
    }

    if (url.pathname === "/api/contact" && request.method === "POST") return contact(request, env);

    if (url.pathname.startsWith("/api/")) return json({ error: "Not Found" }, 404);
    return env.ASSETS.fetch(request);
  },
};
