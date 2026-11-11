/** サイトの一覧・追加・設定・メンバーと招待・削除・デプロイの履歴 */
import { siteOrigin } from "../../http.ts";
import { normalizeSiteName, type SettingsPatch } from "../../sites.ts";
import { PROJECT_NAME } from "../../store.ts";
import { ADMIN_PATH, type Ctx, fail, forbidden, isRecord, type Route, userOf } from "../context.ts";
import { INVITE_TTL_MS } from "../state.ts";
import { ROOT_SITE_MEMBERS } from "./auth.ts";

const siteUrls = (ctx: Ctx, name: string) => ctx.deps.sites.urls(ctx.siteRoot, name);

/** リクエストの vars / secrets を設定の変更にする。値が文字列でないものは文字列にし、シークレットの null は削除 */
export function envPatch(body: Record<string, unknown>): SettingsPatch {
  const patch: SettingsPatch = {};
  if (isRecord(body.vars)) patch.vars = Object.fromEntries(Object.entries(body.vars).map(([k, v]) => [k, String(v ?? "")]));
  if (isRecord(body.secrets)) patch.secrets = Object.fromEntries(Object.entries(body.secrets).map(([k, v]) => [k, v === null ? null : String(v)]));
  return patch;
}

/** サイトを追加する画面で使う: その名前のサイトがあるか、サブドメインがほかのサイトに使われていないか */
function siteInfo(ctx: Ctx, name: string) {
  const { sites } = ctx.deps;
  const valid = PROJECT_NAME.test(name);
  // exists はデプロイ済み（上書きの確認が要る）、created は作成済み（未デプロイを含む）
  const created = valid && sites.has(name);
  const owner = valid ? sites.resolve(name) : undefined;
  return {
    valid,
    exists: valid && sites.deployed(name),
    created,
    // 作成済みのサイトは自分の ID でデプロイできる（ほかのサイトがその名前をサブドメインにしていても構わない）
    takenBy: !created && owner && owner !== name ? owner : null,
    url: valid ? `${siteOrigin(ctx.siteRoot, created ? sites.subdomain(name) : name)}/` : null,
  };
}

export const siteRoutes: Route[] = [
  {
    method: "GET",
    path: "/api/sites",
    auth: "user",
    handle: (ctx) => {
      const { sites, history } = ctx.deps;
      const all = sites.list();
      const names = new Set(all.map((x) => x.name));
      return {
        root: sites.root,
        sites: all
          .filter((x) => ctx.canSite(x.name))
          .map(({ name, store }) => {
            const release = store.get();
            // dynamic: Worker を動かす（子プロセス・メモリ・CPU を使う）、static: ファイルを配信するだけ
            const kind = release ? (release.manifest.main ? "dynamic" : "static") : null;
            return { name, ...siteUrls(ctx, name), deployed: !!release, kind, deployedAt: release?.deployedAt ?? null, latest: history.latest(name) ?? null };
          }),
        // 消したサイトなど、一覧にないサイトのデプロイの失敗
        pending: ctx.isAdmin
          ? history
              .list()
              .filter((d) => !names.has(d.name))
              .slice(0, 10)
          : [],
      };
    },
  },
  {
    // サイトを作る（配信するサブドメインを決める）。デプロイは作ったあとにサイトの画面で選ぶ
    method: "POST",
    path: "/api/sites",
    auth: "admin",
    handle: async (ctx) => {
      const { sites } = ctx.deps;
      const name = normalizeSiteName((await ctx.body()).name);
      if (!PROJECT_NAME.test(name)) return fail(400, "サイト名は英小文字・数字・ハイフンで 63 文字以内にしてください");
      if (sites.has(name)) return fail(409, `サイト ${name} は既にあります`);
      await sites.ensure(name);
      return { name, ...siteInfo(ctx, name) };
    },
  },
  {
    // サイト名の空きを調べるのはサイトを作る管理者だけ（メンバーにほかのサイトの有無を見せない）
    method: "GET",
    path: "/api/site-name",
    auth: "admin",
    handle: (ctx) => siteInfo(ctx, ctx.query.get("name") ?? ""),
  },
  {
    // 一覧にないサイトのデプロイ（消したサイトのものなど）
    method: "GET",
    path: "/api/deployments/:id",
    auth: "user",
    handle: (ctx) => {
      const found = ctx.deps.history.get(ctx.params.id);
      if (found && !ctx.canSite(found.name)) return forbidden();
      return found ?? fail(404, "デプロイが見つかりません");
    },
  },
  {
    method: "GET",
    path: "/api/sites/:site",
    auth: "site",
    handle: async (ctx) => {
      const { sites, repos, history } = ctx.deps;
      const { name, release } = ctx.site;
      const base = { name, ...siteUrls(ctx, name), root: sites.root === name, repo: await repos.exists(name), latest: history.latest(name) ?? null };
      if (!release) return { ...base, deployed: false, release: null };
      const m = release.manifest;
      return {
        ...base,
        deployed: true,
        release: {
          id: release.id,
          name: m.name,
          deployedAt: release.deployedAt,
          deployment: history.forRelease(release.id),
          main: m.main,
          compatibilityDate: m.compatibilityDate,
          compatibilityFlags: m.compatibilityFlags,
          vars: m.vars,
          kv: m.kvNamespaces.map((k) => k.binding),
          r2: m.r2Buckets.map((b) => ({ binding: b.binding, bucket: b.bucketName })),
          assets: m.assets,
        },
      };
    },
  },
  {
    method: "GET",
    path: "/api/sites/:site/settings",
    auth: "site",
    handle: (ctx) => {
      const { sites } = ctx.deps;
      const { name, release } = ctx.site;
      const settings = sites.settings(name);
      return {
        subdomain: sites.subdomain(name),
        vars: settings.vars,
        secretKeys: Object.keys(settings.secrets).sort(),
        wranglerVars: release?.manifest.vars ?? {},
        ...siteUrls(ctx, name),
      };
    },
  },
  {
    method: "PUT",
    path: "/api/sites/:site/settings",
    auth: "site",
    handle: async (ctx) => {
      const { sites, runtime } = ctx.deps;
      const { name, store } = ctx.site;
      const body = await ctx.body();
      const patch = envPatch(body);
      if ("subdomain" in body) patch.subdomain = body.subdomain === null ? null : String(body.subdomain ?? "");
      await sites.updateSettings(name, patch);
      // 次のリクエストから新しい値で Worker を読み込み直す
      runtime.evict(store.siteDir);
      return { ok: true, subdomain: sites.subdomain(name), ...siteUrls(ctx, name) };
    },
  },
  {
    method: "GET",
    path: "/api/sites/:site/members",
    auth: "siteAdmin",
    handle: (ctx) => {
      const { state } = ctx.deps;
      const { name } = ctx.site;
      const invites = state
        .invites(name)
        .map((i) => ({ id: i.id, createdAt: i.createdAt, expiresAt: i.expiresAt, createdBy: state.user(i.createdBy)?.name ?? null }));
      const members = state.users.filter((u) => u.role === "member" && u.sites.includes(name)).map((u) => ({ id: u.id, name: u.name, createdAt: u.createdAt }));
      return { members, invites };
    },
  },
  {
    method: "DELETE",
    path: "/api/sites/:site/members/:id",
    auth: "siteAdmin",
    handle: async (ctx) => {
      const { state } = ctx.deps;
      if (!state.user(ctx.params.id)) return fail(404, "ユーザーが見つかりません");
      await state.updateUser(ctx.params.id, { removeSite: ctx.site.name });
      return { ok: true };
    },
  },
  {
    method: "POST",
    path: "/api/sites/:site/invites",
    auth: "siteAdmin",
    handle: async (ctx) => {
      const { state, sites } = ctx.deps;
      const { name } = ctx.site;
      if (sites.root === name) return fail(400, ROOT_SITE_MEMBERS);
      const { token, invite } = await state.createInvite(name, userOf(ctx).id);
      return { id: invite.id, expiresAt: invite.expiresAt, ttlDays: INVITE_TTL_MS / 86_400_000, url: `${ctx.origin}${ADMIN_PATH}/#/invite/${token}` };
    },
  },
  {
    method: "DELETE",
    path: "/api/sites/:site/invites/:id",
    auth: "siteAdmin",
    handle: async (ctx) => ((await ctx.deps.state.revokeInvite(ctx.site.name, ctx.params.id)) ? { ok: true } : fail(404, "招待が見つかりません")),
  },
  {
    method: "DELETE",
    path: "/api/sites/:site",
    auth: "site",
    handle: async (ctx) => {
      const { deployer, runtime, state, sites, repos, history, observability } = ctx.deps;
      const { name, store } = ctx.site;
      // 進行中のデプロイ（アップロード・git push）が終わるのを待ってから消す（消したあとにリリースを書かせない）
      await deployer.exclusive(name, async () => {
        // 処理中のリクエストも待たずに止める（消したあとに Worker が KV / R2 を書いて、ディレクトリを作り直さないように）
        runtime.evict(store.siteDir, { now: true });
        await state.removeSiteAccess(name);
        await sites.remove(name);
        // リポジトリはサイトに属するので一緒に消す（残すと次の起動で空のサイトとして戻ってくる）
        await repos.remove(name);
        history.clear(name);
        observability.clear(name);
      });
      return { ok: true };
    },
  },
  {
    method: "GET",
    path: "/api/sites/:site/deployments",
    auth: "site",
    handle: (ctx) => ({ deployments: ctx.deps.history.list(ctx.site.name), active: ctx.site.release?.id ?? null }),
  },
  {
    method: "GET",
    path: "/api/sites/:site/deployments/:id",
    auth: "site",
    handle: (ctx) => ctx.deps.history.get(ctx.params.id, ctx.site.name) ?? fail(404, "デプロイが見つかりません"),
  },
];
