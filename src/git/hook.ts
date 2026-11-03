// git の post-receive フック。push された ref を Kanzume に伝え、デプロイのログを push した人の端末（remote: …）に流す
import { text } from "node:stream/consumers";

const updates = (await text(process.stdin))
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const [old, next, ref] = line.split(" ");
    return { old, new: next, ref };
  });

try {
  const res = await fetch(process.env.KANZUME_HOOK_URL!, {
    method: "POST",
    headers: { "content-type": "application/json", "x-kanzume-hook": process.env.KANZUME_HOOK_SECRET ?? "" },
    body: JSON.stringify({ repo: process.env.KANZUME_REPO, origin: process.env.KANZUME_ORIGIN_URL, scope: process.env.KANZUME_PUSH_SCOPE, updates }),
  });
  if (!res.ok || !res.body) {
    // サーバーが再起動して合言葉が変わった直後など。同じコミットは push し直せないので、空のコミットを案内する
    throw new Error(`HTTP ${res.status}。デプロイされていないので、git commit --allow-empty で空のコミットを作って push し直してください`);
  }
  for await (const chunk of res.body) process.stdout.write(chunk);
} catch (err) {
  // push 自体は受け付け済みなので、失敗しても終了コードは 0 にする
  process.stdout.write(`Kanzume に push を伝えられませんでした: ${(err as Error).message}\n`);
}
