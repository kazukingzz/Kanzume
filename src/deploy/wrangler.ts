import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { PROJECT_NAME, type HtmlHandling, type Manifest, type NotFoundHandling } from "../store.ts";

export const CONFIG_FILES = ["wrangler.jsonc", "wrangler.json", "wrangler.toml"] as const;

export class ConfigError extends Error {}

export function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      out += text.slice(start, ++i);
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

export function parseWranglerConfig(filename: string, text: string): Record<string, unknown> {
  try {
    const raw = filename.endsWith(".toml") ? JSON.parse(JSON.stringify(parseToml(text))) : JSON.parse(stripJsonc(text));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("not an object");
    return raw as Record<string, unknown>;
  } catch (err) {
    throw new ConfigError(`${filename} を読み込めません: ${(err as Error).message}`);
  }
}

const HTML_HANDLING: HtmlHandling[] = ["auto-trailing-slash", "force-trailing-slash", "drop-trailing-slash", "none"];
const NOT_FOUND_HANDLING: NotFoundHandling[] = ["none", "single-page-application", "404-page"];
const BINDING_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function asObject(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConfigError(`${field} はオブジェクトで指定してください`);
  return value as Record<string, unknown>;
}

function asArray(value: unknown, field: string): Record<string, unknown>[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ConfigError(`${field} は配列で指定してください`);
  return value.map((v, i) => asObject(v, `${field}[${i}]`));
}

function binding(value: unknown, field: string): string {
  if (typeof value !== "string" || !BINDING_NAME.test(value)) throw new ConfigError(`${field} が不正です`);
  return value;
}

export function toManifest(raw: Record<string, unknown>, hasWorker: boolean): Manifest {
  const name = raw.name;
  if (typeof name !== "string" || !PROJECT_NAME.test(name)) {
    throw new ConfigError("name は英小文字・数字・ハイフンで 63 文字以内にしてください");
  }

  let main: string | null = null;
  if (typeof raw.main === "string" && hasWorker) {
    main = `${path.basename(raw.main).replace(/\.[^.]+$/, "")}.cjs`;
  } else if (raw.main !== undefined && !hasWorker) {
    throw new ConfigError("main が指定されていますがバンドルが含まれていません");
  }

  const vars = asObject(raw.vars, "vars");
  const kvNamespaces = asArray(raw.kv_namespaces, "kv_namespaces").map((kv, i) => ({
    binding: binding(kv.binding, `kv_namespaces[${i}].binding`),
  }));
  const r2Buckets = asArray(raw.r2_buckets, "r2_buckets").map((r2, i) => {
    const bucketName = r2.bucket_name ?? r2.binding;
    if (typeof bucketName !== "string" || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(bucketName)) {
      throw new ConfigError(`r2_buckets[${i}].bucket_name が不正です`);
    }
    return { binding: binding(r2.binding, `r2_buckets[${i}].binding`), bucketName };
  });

  let assets: Manifest["assets"] = null;
  if (raw.assets !== undefined) {
    const a = asObject(raw.assets, "assets");
    const htmlHandling = (a.html_handling ?? "auto-trailing-slash") as HtmlHandling;
    const notFoundHandling = (a.not_found_handling ?? "none") as NotFoundHandling;
    if (!HTML_HANDLING.includes(htmlHandling)) throw new ConfigError("assets.html_handling が不正です");
    if (!NOT_FOUND_HANDLING.includes(notFoundHandling)) throw new ConfigError("assets.not_found_handling が不正です");
    const runWorkerFirst = a.run_worker_first ?? false;
    if (typeof runWorkerFirst !== "boolean" && !(Array.isArray(runWorkerFirst) && runWorkerFirst.every((p) => typeof p === "string"))) {
      throw new ConfigError("assets.run_worker_first は真偽値か文字列の配列で指定してください");
    }
    assets = {
      binding: a.binding === undefined ? null : binding(a.binding, "assets.binding"),
      htmlHandling,
      notFoundHandling,
      runWorkerFirst,
    };
  }

  if (!main && !assets) throw new ConfigError("main か assets のどちらかが必要です");

  return {
    name,
    main,
    compatibilityDate: typeof raw.compatibility_date === "string" ? raw.compatibility_date : null,
    compatibilityFlags: Array.isArray(raw.compatibility_flags) ? raw.compatibility_flags.filter((f) => typeof f === "string") : [],
    vars,
    kvNamespaces,
    r2Buckets,
    assets,
  };
}
