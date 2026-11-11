// git の pre-receive フック。push を受け入れる前に、デフォルトブランチの削除と容量の超過を拒否する。
// 出力は push した人の端末に remote: … として出て、終了コード 1 で push 全体を取り消す。
import fs from "node:fs/promises";
import path from "node:path";
import { text } from "node:stream/consumers";
import { dirSize } from "./repos.ts";

const ZERO = /^0+$/;
const gitDir = path.resolve(process.env.GIT_DIR ?? ".");
const updates = (await text(process.stdin))
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const [old, next, ref] = line.split(" ");
    return { old, new: next, ref };
  });

const head = await fs.readFile(path.join(gitDir, "HEAD"), "utf8").catch(() => "");
const defaultRef = /^ref: (refs\/heads\/.+)$/m.exec(head)?.[1].trim() ?? "refs/heads/main";

for (const u of updates) {
  if (u.ref === defaultRef && ZERO.test(u.new)) {
    process.stdout.write(`${defaultRef.slice("refs/heads/".length)} はデプロイ元なので削除できません\n`);
    process.exit(1);
  }
}

// 受け取ったオブジェクトは objects/ の下の一時ディレクトリにあるので、objects/ 全体で今回の push 後の大きさになる
const quota = Number(process.env.KANZUME_REPO_QUOTA_BYTES ?? 0);
if (quota > 0) {
  const size = await dirSize(path.join(gitDir, "objects"));
  if (size > quota) {
    process.stdout.write(
      `リポジトリの容量の上限（${Math.round(quota / 1024 / 1024)} MB）を超えるので受け付けません（push 後 ${Math.round(size / 1024 / 1024)} MB）\n`,
    );
    process.exit(1);
  }
}
