import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { test, type TestContext } from "node:test";
import { rawTar, rawTarEntry } from "./helpers.ts";
import { cookieFor, fakeCredential, startApp } from "./fixtures.ts";

/** デプロイを受け付けたあと（順番待ちの間）に権限やサイトが変わったら、反映しないこと */

const staticTarGz = (site: string, text: string) =>
  gzipSync(
    rawTar([
      rawTarEntry("wrangler.jsonc", Buffer.from(JSON.stringify({ name: site, compatibility_date: "2026-10-01", assets: { directory: "public" } }))),
      rawTarEntry("assets/index.html", Buffer.from(text)),
    ]),
  );

async function start(t: TestContext) {
  const app = await startApp(t);
  const member = async (sites: string[]) => {
    const user = await app.state.createUser("参加者", "member", sites);
    await app.state.addCredential(fakeCredential(`cred-${user.id}`, user.id));
    const { token, info } = await app.state.createUserToken(user.id, "test", null);
    return { user, token, tokenId: info.id, cookie: cookieFor(await app.state.createSession(user.id)) };
  };
  /** /_api/deploy（GitHub Actions）。サイトは作らない */
  const actions = (site: string, token: string, text = "new") =>
    fetch(`${app.base}/_api/deploy`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "x-kanzume-site": site },
      body: new Uint8Array(staticTarGz(site, text)),
    });
  /**
   * 受け付けの順番待ちを止めておく。返り値を呼ぶと流れ出す。
   * 止めている間に send したリクエストは、権限の確認を済ませてから順番を待つ
   */
  const holdIntake = () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    app.deployer.intake(() => held);
    return release;
  };
  const holdSite = (site: string) => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    app.deployer.exclusive(site, () => held);
    return release;
  };
  /** リクエストが受け付けの処理まで届くのを待つ */
  const settle = () => new Promise((r) => setTimeout(r, 300));
  return { ...app, member, actions, holdIntake, holdSite, settle };
}

const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;

test("Actions のデプロイは、順番を待つ間にトークンを取り消したり、サイトから外したりすると反映されない", async (t) => {
  const app = await start(t);
  await app.sites.ensure("docs");
  const m = await app.member(["docs"]);

  let release = app.holdIntake();
  const revoked = app.actions("docs", m.token);
  await app.settle();
  await app.state.revokeUserToken(m.user.id, m.tokenId);
  release();
  const res1 = await revoked;
  assert.equal(res1.status, 400);
  assert.match(await errorOf(res1), /トークンかログインが無効/);

  const m2 = await app.member(["docs"]);
  release = app.holdIntake();
  const removed = app.actions("docs", m2.token);
  await app.settle();
  await app.state.updateUser(m2.user.id, { removeSite: "docs" });
  release();
  const res2 = await removed;
  assert.equal(res2.status, 400);
  assert.match(await errorOf(res2), /docs を扱えなくなった/);

  assert.equal(app.sites.get("docs")!.get(), undefined, "どちらも反映されない");
  assert.ok(app.history.list("docs").every((d) => d.status === "failed"));
});

test("順番を待つ間にサイトを消して同じ名前で作り直すと、管理者のトークンでも反映されない", async (t) => {
  const app = await start(t);
  await app.sites.ensure("docs");
  const release = app.holdIntake();
  const pending = app.actions("docs", app.token);
  await app.settle();
  await app.sites.remove("docs");
  await app.sites.ensure("docs");
  release();
  const res = await pending;
  assert.equal(res.status, 400);
  assert.match(await errorOf(res), /作り直された/);
  assert.equal(app.sites.get("docs")!.get(), undefined);
});

test("順番を待つ間にルートドメインのサイトになったら、メンバーのデプロイは反映されない", async (t) => {
  const app = await start(t);
  await app.sites.ensure("docs");
  const m = await app.member(["docs"]);
  const release = app.holdIntake();
  const pending = app.actions("docs", m.token);
  await app.settle();
  await app.sites.setRoot("docs");
  release();
  const res = await pending;
  assert.equal(res.status, 400);
  assert.match(await errorOf(res), /ルートドメインで配信しているサイトには、管理者しかデプロイできません/);
  assert.equal(app.sites.get("docs")!.get(), undefined);

  // 管理者は今までどおりルートのサイトにデプロイできる
  assert.equal((await app.actions("docs", app.token)).status, 200);
});

test("管理画面のアップロードは、順番を待つ間にサイトから外されると反映もコミットもされない", async (t) => {
  const app = await start(t);
  await app.sites.ensure("docs");
  const m = await app.member(["docs"]);
  const release = app.holdSite("docs");
  const pending = fetch(`${app.base}/_admin/kanzume/api/sites/docs/deploy-upload`, {
    method: "POST",
    headers: { cookie: m.cookie, origin: app.base, "content-type": "application/gzip" },
    body: new Uint8Array(gzipSync(rawTar([rawTarEntry("index.html", Buffer.from("new"))]))),
  });
  await app.settle();
  await app.state.updateUser(m.user.id, { removeSite: "docs" });
  release();
  const res = await pending;
  assert.equal(res.status, 403);
  assert.match(await errorOf(res), /docs を扱えなくなった/);
  assert.equal(app.sites.get("docs")!.get(), undefined);
  assert.equal(await app.repos.exists("docs"), false, "リポジトリも作らない");
});

test("ビルド失敗の報告は、そのトークンでデプロイできるサイトにだけ残せる", async (t) => {
  const app = await start(t);
  await app.sites.ensure("docs");
  await app.sites.ensure("shop");
  const m = await app.member(["docs"]);
  const report = (token: string, body: Record<string, unknown>) =>
    fetch(`${app.base}/_api/deploy/report`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  assert.equal((await report(m.token, { site: "docs", error: "本物の失敗" })).status, 200);
  assert.equal((await report(m.token, { site: "shop", error: "偽の失敗" })).status, 403, "ほかのサイトには書けない");
  assert.equal((await report(m.token, { error: "どのサイトでもない失敗" })).status, 400, "サイトを決めない報告は受けない");
  assert.equal((await report(m.token, { site: "nope", error: "x" })).status, 404);
  await app.sites.setRoot("docs");
  assert.equal((await report(m.token, { site: "docs", error: "ルートへの報告" })).status, 403, "デプロイできないルートのサイトにも書けない");

  const errors = app.history.list().map((d) => [d.name, d.error]);
  assert.deepEqual(errors, [["docs", "本物の失敗"]]);
});
