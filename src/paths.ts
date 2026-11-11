import path from "node:path";

/** p が root そのものか、root の中にあるか（どちらも path.resolve 済みの絶対パス） */
export function isInside(root: string, p: string): boolean {
  return p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}
