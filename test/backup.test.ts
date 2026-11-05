import assert from "node:assert/strict";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { Backup } from "../src/backup/backup.ts";
import { KeyMismatchError } from "../src/backup/crypto.ts";
import { LocalStore, S3Store, signV4 } from "../src/backup/store.ts";
import { BackupUrlError, parseBackupUrl } from "../src/backup/url.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { DeployLog } from "../src/deploy/deployer.ts";
import { deployFromFiles } from "../src/deploy/github.ts";
import { createServer, prepareBackup } from "../src/server.ts";
import { tmpDir } from "./helpers.ts";

const fakeCredential = { id: "cred-1", publicKey: "AAAA", counter: 0, createdAt: new Date().toISOString() };

const WORKER = `export default {
  async fetch(request, env) {
    const key = new URL(request.url).pathname;
    if (request.method === "PUT") {
      await env.KV.put(key, "kv" + key);
      await env.BUCKET.put(key, "r2" + key);
      return new Response("ok");
    }
    const obj = await env.BUCKET.get(key);
    return Response.json({ kv: await env.KV.get(key), r2: obj ? await obj.text() : null });
  },
};`;
const WRANGLER = JSON.stringify({ name: "app", main: "index.js", compatibility_date: "2026-10-01", kv_namespaces: [{ binding: "KV", id: "x" }], r2_buckets: [{ binding: "BUCKET", bucket_name: "files" }] });

/** 起動と同じ手順（復元 → サーバー作成）で立ち上げる */
async function boot(t: TestContext, config: Config) {
  const backup = await prepareBackup(config);
  const app = await createServer(config, { backup });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await new Promise((resolve) => app.server.close(resolve));
    await app.state.flush();
  };
  t.after(close);
  return { ...app, backup: backup!, close, base: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}` };
}

async function call(app: Awaited<ReturnType<typeof boot>>, method: string, key: string) {
  const release = app.sites.get("app")!.get()!;
  const worker = await app.runtime.get(release);
  return (await worker.fetch(new Request(`http://x${key}`, { method }))).response!;
}

function configs(t: TestContext, query = "") {
  const store = tmpDir(t);
  return { store, make: () => loadConfig({ KANZUME_DATA_DIR: tmpDir(t), KANZUME_BACKUP_URL: `file://${store}${query}` }) };
}

async function setup(app: Awaited<ReturnType<typeof boot>>) {
  await app.state.addCredential(fakeCredential);
  const result = await deployFromFiles(
    [
      { path: "wrangler.jsonc", data: Buffer.from(WRANGLER) },
      { path: "index.js", data: Buffer.from(WORKER) },
    ],
    app.deployer,
    { source: {}, log: new DeployLog("test"), buildLog: [], autoRoot: true },
  );
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  await app.sites.updateSettings("app", { secrets: { TOKEN: "s" } });
  await app.repos.create("app");
  await call(app, "PUT", "/a");
}

test("データを作ってバックアップし、/data を消して再起動すると復元される。2 回目からは変わったものだけ送る", async (t) => {
  const { store, make } = configs(t);
  const config = make();
  const app = await boot(t, config);
  assert.equal(app.backup.lastRestore, null);
  await setup(app);

  const first = await app.backup.backupNow("test");
  assert.equal(first.ok, true, first.error);
  assert.ok(first.snapshot);
  assert.ok(first.uploadedFiles! > 5);

  // R2 のオブジェクトを 1 つ足すと、送るのはそのファイルと変わった DB だけ
  await call(app, "PUT", "/b");
  const second = await app.backup.backupNow("test");
  assert.equal(second.ok, true, second.error);
  assert.ok(second.uploadedFiles! >= 2 && second.uploadedFiles! <= 3, `送ったファイル: ${second.uploadedFiles}`);
  const third = await app.backup.backupNow("test");
  assert.equal(third.skipped, "前回から変更がありません");
  assert.equal((await app.backup.snapshots()).length, 2);

  // 保存先には平文が残らない
  for (const key of await new LocalStore(store).list("")) {
    const data = fs.readFileSync(path.join(store, key));
    assert.ok(!data.includes("kv/a") && !data.includes("credentials"), key);
  }

  await app.close();
  fs.rmSync(config.dataDir, { recursive: true, force: true });

  const restored = await boot(t, config);
  assert.equal(restored.backup.lastRestore?.ok, true);
  assert.equal(restored.backup.lastRestore?.snapshot, second.snapshot);
  assert.equal(restored.state.credentials.length, 1);
  assert.equal(restored.sites.root, "app");
  assert.deepEqual(restored.sites.settings("app").secrets, { TOKEN: "s" });
  assert.deepEqual(await (await call(restored, "GET", "/a")).json(), { kv: "kv/a", r2: "r2/a" });
  assert.deepEqual(await (await call(restored, "GET", "/b")).json(), { kv: "kv/b", r2: "r2/b" });
  assert.equal(await restored.repos.exists("app"), true);
  assert.equal((await restored.repos.summary("app")).defaultBranch, "main");
  assert.equal(restored.history.list().length, 1, "デプロイ履歴（meta.sqlite）も戻る");
  assert.ok(!fs.existsSync(path.join(config.dataDir, ".restoring")));

  // データがあるときは復元しない
  await restored.close();
  const again = await boot(t, config);
  assert.equal(again.backup.lastRestore, null);
});

test("空の /data でバックアップしても、既存の世代を上書きしない", async (t) => {
  const { make } = configs(t);
  const app = await boot(t, make());
  await setup(app);
  const first = await app.backup.backupNow("test");
  assert.equal(first.ok, true, first.error);

  // 復元せずに（バックアップがないかのように）空の /data で動いているサーバー
  const empty = make();
  const backup = new Backup(empty.backup!, empty.dataDir);
  const blank = await createServer(empty, { backup });
  t.after(() => blank.server.close());
  const run = await backup.backupNow("定期");
  assert.equal(run.ok, true);
  assert.match(run.skipped ?? "", /不完全/);
  assert.deepEqual(await backup.snapshots(), [first.snapshot]);
});

test("残す世代の数を超えた古い世代と、使われなくなったデータを消す", async (t) => {
  const { store, make } = configs(t, "?keep=2");
  const app = await boot(t, make());
  await setup(app);
  const names: string[] = [];
  const local = new LocalStore(store);
  let before: string[] = [];
  for (const k of ["/x", "/y", "/z"]) {
    before = await local.list("blobs/");
    await call(app, "PUT", k);
    await app.sites.updateSettings("app", { vars: { K: k } });
    const run = await app.backup.backupNow("test");
    assert.equal(run.ok, true, run.error);
    names.push(run.snapshot!);
  }
  assert.deepEqual(await app.backup.snapshots(), names.slice(1));
  // 最初の世代だけが参照していたデータ（K=/x の settings.json など）は消え、残りの世代は復元できる
  const after = new Set(await local.list("blobs/"));
  assert.ok(before.some((k) => !after.has(k)), "使われなくなったデータが消える");
  const fresh = new Backup(make().backup!, tmpDir(t));
  await fresh.restoreIfEmpty();
  assert.equal(fresh.lastRestore?.ok, true);
  assert.equal(fresh.lastRestore?.snapshot, names[2]);
});

test("SECRET を替えたら previous を付けて起動すると鍵を包み直し、以後は新しい鍵だけで全世代を読める", async (t) => {
  const store = tmpDir(t);
  const cfg = (q: string) => loadConfig({ KANZUME_DATA_DIR: tmpDir(t), KANZUME_BACKUP_URL: `file://${store}?${q}` });
  const app = await boot(t, cfg("secret=old"));
  await setup(app);
  assert.equal((await app.backup.backupNow("test")).ok, true);

  const wrong = cfg("secret=new");
  await assert.rejects(new Backup(wrong.backup!, wrong.dataDir).restoreIfEmpty(), KeyMismatchError);
  // 鍵が合わなくても新しい鍵は作らない
  assert.equal((await new LocalStore(store).list("keys/")).length, 1);

  const rotated = cfg("secret=new&previous=old");
  const b1 = new Backup(rotated.backup!, rotated.dataDir);
  assert.equal((await b1.restoreIfEmpty())?.ok, true);
  assert.equal((await new LocalStore(store).list("keys/")).length, 2);

  const after = cfg("secret=new");
  const b2 = new Backup(after.backup!, after.dataDir);
  assert.equal((await b2.restoreIfEmpty())?.ok, true);
});

test("KANZUME_BACKUP_URL を読む（パーセントエンコード・プレフィックス・file://）", () => {
  assert.equal(parseBackupUrl(undefined), null);
  assert.equal(parseBackupUrl(""), null);
  const r2 = parseBackupUrl("s3://AKID:se%2Fcr%2Bet%40x%3A@acct.r2.cloudflarestorage.com/my-bucket");
  assert.deepEqual(
    { ...r2, intervalMs: undefined },
    {
      kind: "s3",
      endpoint: "https://acct.r2.cloudflarestorage.com",
      bucket: "my-bucket",
      prefix: "",
      accessKeyId: "AKID",
      secret: "se/cr+et@x:",
      region: "auto",
      previous: undefined,
      keep: 48,
      intervalMs: undefined,
      target: "acct.r2.cloudflarestorage.com/my-bucket",
    },
  );
  const withPrefix = parseBackupUrl("s3://AKID:SECRET@acct.r2.cloudflarestorage.com/b/kanzume/prod?keep=10&interval=30&previous=old%2Fkey")!;
  assert.equal(withPrefix.kind === "s3" && withPrefix.prefix, "kanzume/prod");
  assert.equal(withPrefix.keep, 10);
  assert.equal(withPrefix.intervalMs, 30 * 60_000);
  assert.equal(withPrefix.previous, "old/key");
  assert.equal(withPrefix.target, "acct.r2.cloudflarestorage.com/b/kanzume/prod");
  const aws = parseBackupUrl("s3://A:B@s3.ap-northeast-1.amazonaws.com/b")!;
  assert.equal(aws.kind === "s3" && aws.region, "ap-northeast-1");
  const minio = parseBackupUrl("s3+http://A:B@localhost:9000/b")!;
  assert.equal(minio.kind === "s3" && minio.endpoint, "http://localhost:9000");
  assert.deepEqual(parseBackupUrl("file:///var/backup%20dir"), { kind: "file", dir: "/var/backup dir", secret: "kanzume-local-backup", previous: undefined, keep: 48, intervalMs: 3_600_000, target: "file:///var/backup dir" });

  // エラーに URL（認証情報）を含めない
  for (const bad of ["s3://AKID:TOPSECRET@host", "s3://host/bucket", "http://AKID:TOPSECRET@host/b", "s3://AKID:TOP%ZZSECRET@host/b", "s3://AKID:TOPSECRET@host/b?keep=0", "not a url TOPSECRET", "file:///"]) {
    assert.throws(
      () => parseBackupUrl(bad),
      (err: Error) => err instanceof BackupUrlError && !err.message.includes("TOPSECRET") && !err.message.includes("AKID"),
      bad,
    );
  }
});

test("SigV4 の署名が AWS のドキュメントの例と一致する", () => {
  const auth = signV4({
    method: "GET",
    path: "/test.txt",
    query: {},
    headers: {
      host: "examplebucket.s3.amazonaws.com",
      range: "bytes=0-9",
      "x-amz-content-sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "x-amz-date": "20130524T000000Z",
    },
    payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
    amzDate: "20130524T000000Z",
  });
  assert.equal(
    auth,
    "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
  );
});

/** メモリ上の S3 互換 API（署名の有無とページングだけ見る） */
function fakeS3(pageSize = 2) {
  const objects = new Map<string, Uint8Array>();
  const requests: string[] = [];
  const fetcher = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    requests.push(`${init.method} ${url.pathname}${url.search}`);
    assert.match(String((init.headers as Record<string, string>).authorization), /^AWS4-HMAC-SHA256 Credential=AKID\//);
    assert.ok(!String(input).includes("TOPSECRET"));
    const [, bucket, ...rest] = url.pathname.split("/");
    assert.equal(bucket, "bkt");
    const key = rest.map(decodeURIComponent).join("/");
    if (init.method === "PUT") {
      objects.set(key, new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer()));
      return new Response(null, { status: 200 });
    }
    if (init.method === "DELETE") {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    if (!key) {
      const prefix = url.searchParams.get("prefix") ?? "";
      const all = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = Number(url.searchParams.get("continuation-token") ?? 0);
      const page = all.slice(start, start + pageSize);
      const more = start + pageSize < all.length;
      const xml = `<ListBucketResult>${page.map((k) => `<Contents><Key>${k.replace(/&/g, "&amp;")}</Key></Contents>`).join("")}<IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${start + pageSize}</NextContinuationToken>` : ""}</ListBucketResult>`;
      return new Response(xml);
    }
    const obj = objects.get(key);
    return obj ? new Response(obj as BodyInit) : new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
  }) as typeof fetch;
  return { objects, requests, fetcher };
}

test("S3Store: プレフィックスの下に読み書きし、一覧はページングをたどる", async () => {
  const s3 = fakeS3();
  const store = new S3Store({ endpoint: "https://acct.r2.cloudflarestorage.com", bucket: "bkt", prefix: "kz/prod", accessKeyId: "AKID", secret: "TOPSECRET", region: "auto", fetch: s3.fetcher });
  for (const k of ["blobs/a", "blobs/b", "blobs/c&d", "snapshots/x/manifest"]) await store.put(k, Buffer.from(k));
  assert.ok([...s3.objects.keys()].every((k) => k.startsWith("kz/prod/")));
  assert.deepEqual(await store.list("blobs/"), ["blobs/a", "blobs/b", "blobs/c&d"]);
  assert.equal(Buffer.from((await store.get("blobs/c&d"))!).toString(), "blobs/c&d");
  assert.equal(await store.get("nope"), null);
  await store.delete("blobs/a");
  assert.deepEqual(await store.list("blobs/"), ["blobs/b", "blobs/c&d"]);
});

test("S3 のエラーやログに認証情報を出さない", async (t) => {
  const fetcher = (async () =>
    new Response("<Error><Code>SignatureDoesNotMatch</Code><Message>bad TOPSECRET</Message><AWSAccessKeyId>AKIDXYZ</AWSAccessKeyId></Error>", { status: 403 })) as unknown as typeof fetch;
  const store = new S3Store({ endpoint: "https://acct.r2.cloudflarestorage.com", bucket: "bkt", prefix: "", accessKeyId: "AKIDXYZ", secret: "TOPSECRET", region: "auto", fetch: fetcher });
  await assert.rejects(store.put("k", Buffer.from("x")), (err: Error) => /SignatureDoesNotMatch/.test(err.message) && !err.message.includes("TOPSECRET") && !err.message.includes("AKIDXYZ"));

  // バックアップが失敗したときのログ・状態にも出ない
  const config = parseBackupUrl("s3://AKIDXYZ:TOPSECRET@acct.r2.cloudflarestorage.com/bkt")!;
  const dataDir = tmpDir(t);
  fs.writeFileSync(path.join(dataDir, "admin.json"), JSON.stringify({ credentials: [fakeCredential] }));
  const backup = new Backup(config, dataDir, store);
  const logs: string[] = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  for (const k of ["log", "error", "warn"] as const) console[k] = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  try {
    const run = await backup.backupNow("test");
    assert.equal(run.ok, false);
  } finally {
    Object.assign(console, orig);
  }
  const all = [...logs, JSON.stringify(backup.status())].join("\n");
  assert.ok(logs.length > 0);
  assert.ok(!all.includes("TOPSECRET") && !all.includes("AKIDXYZ"), all);
  assert.match(all, /acct\.r2\.cloudflarestorage\.com\/bkt/);
});

test("S3 互換の保存先でもバックアップと復元ができる", async (t) => {
  const s3 = fakeS3(3);
  const config = parseBackupUrl("s3://AKID:TOPSECRET@acct.r2.cloudflarestorage.com/bkt/kanzume")!;
  const make = () => {
    const c = loadConfig({ KANZUME_DATA_DIR: tmpDir(t) });
    return { ...c, backup: config };
  };
  const c1 = make();
  const b1 = new Backup(config, c1.dataDir, new S3Store({ ...(config as Extract<typeof config, { kind: "s3" }>), fetch: s3.fetcher }));
  const app = await createServer(c1, { backup: b1 });
  t.after(() => app.server.close());
  await app.state.addCredential(fakeCredential);
  await app.repos.create("r");
  assert.equal((await b1.backupNow("test")).ok, true);

  const c2 = make();
  const b2 = new Backup(config, c2.dataDir, new S3Store({ ...(config as Extract<typeof config, { kind: "s3" }>), fetch: s3.fetcher }));
  assert.equal((await b2.restoreIfEmpty())?.ok, true);
  assert.ok(fs.existsSync(path.join(c2.dataDir, "repos", "r.git", "HEAD")));
  assert.ok(fs.existsSync(path.join(c2.dataDir, "repos", "r.git", "refs", "heads")), "空のディレクトリも戻る");
});
