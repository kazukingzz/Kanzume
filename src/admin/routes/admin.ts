/** 全体の設定（管理者）: ドメイン・ルートのサイト・バックアップ・リソース */
import path from "node:path";
import { processRss } from "../../observability/resources.ts";
import { fail, reply, type Route } from "../context.ts";

export const adminRoutes: Route[] = [
  {
    method: "POST",
    path: "/api/domain",
    auth: "admin",
    handle: async (ctx) => {
      const { state, config } = ctx.deps;
      if (config.origin) return fail(409, "環境変数 KANZUME_ORIGIN が優先されています。変えるには環境変数を変更してください");
      const body = await ctx.body();
      // 読めない本文や domain のない本文で、保存したドメインを消さない（null か "" で消す）
      if (typeof body.domain !== "string" && body.domain !== null) return fail(400, "domain を指定してください");
      return { domain: await state.setDomain(String(body.domain ?? "")) };
    },
  },
  {
    // ルートドメイン（サブドメインなし）で配信するサイトを選ぶ。null で外す
    method: "POST",
    path: "/api/root-site",
    auth: "admin",
    handle: async (ctx) => {
      const { state, sites } = ctx.deps;
      const body = await ctx.body();
      const name = body.name === null ? null : String(body.name ?? "");
      if (name !== null && !sites.get(name)?.get()) return fail(404, "サイトが見つかりません");
      // ルートは管理画面と同じオリジンで動くので、メンバーが扱えるサイトはルートにしない
      if (name !== null && state.siteHasMembers(name)) {
        return fail(400, "メンバー（または未使用の招待）がいるサイトは、ルートドメインにできません（管理画面と同じオリジンで動くため）");
      }
      await sites.setRoot(name);
      return { root: sites.root };
    },
  },
  {
    method: "GET",
    path: "/api/backup",
    auth: "admin",
    handle: (ctx) => (ctx.deps.backup ? ctx.deps.backup.status() : { enabled: false }),
  },
  {
    method: "POST",
    path: "/api/backup/run",
    auth: "admin",
    handle: async (ctx) => {
      const { backup } = ctx.deps;
      if (!backup) return fail(400, "KANZUME_BACKUP_URL が設定されていません");
      const run = await backup.backupNow("手動");
      return reply(run.ok ? 200 : 502, { ...backup.status(), error: run.error });
    },
  },
  {
    method: "GET",
    path: "/api/resources",
    auth: "admin",
    handle: (ctx) => {
      const { runtime, resources } = ctx.deps;
      const workers = runtime.processes().map((p) => ({ site: path.basename(p.siteDir), pid: p.pid, rss: processRss(p.pid) }));
      return { ...resources.snapshot(), workers };
    },
  },
  {
    // GitHub の公開リポジトリからのデプロイで案内するサンプル
    method: "GET",
    path: "/api/samples",
    auth: "user",
    handle: (ctx) => ({ worker: `${ctx.deps.config.samplesRepo}/examples/worker` }),
  },
];
