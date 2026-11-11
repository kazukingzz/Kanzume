// git のフック（pre-receive・post-receive）が stdin で受け取る「古い SHA 新しい SHA ref」の行を読む
import { text } from "node:stream/consumers";

export interface RefUpdate {
  old: string;
  new: string;
  ref: string;
}

export async function readRefUpdates(): Promise<RefUpdate[]> {
  return (await text(process.stdin))
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [old, next, ref] = line.split(" ");
      return { old, new: next, ref };
    });
}
