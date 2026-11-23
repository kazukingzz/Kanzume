/** デプロイを受け付けたときの権限を、反映の直前に確かめ直すための guard（deployer.ts の DeployGuard）を作る */
import type { AdminState, User } from "../admin/state.ts";
import type { Sites } from "../sites.ts";
import type { DeployGuard } from "./deployer.ts";

/**
 * 今のユーザー（トークンやログインが無効になっていれば null）が、受け付けたときと同じサイトを今も扱えるか。
 * サイトは名前ではなく Store で比べる（消して同じ名前で作り直したサイトは、別のサイトとして扱う）
 */
function guardFor(currentUser: () => User | null, sites: Sites, site: string): DeployGuard {
  const expected = sites.get(site);
  return (store) => {
    const user = currentUser();
    if (!user) return { ok: false, error: "受け付けたあとにトークンかログインが無効になったため、デプロイしません" };
    const admin = user.role === "admin";
    if (!admin && !user.sites.includes(site)) return { ok: false, error: `受け付けたあとにサイト ${site} を扱えなくなったため、デプロイしません` };
    if (!expected || store !== expected) return { ok: false, error: `受け付けたあとにサイト ${site} が作り直されたため、デプロイしません` };
    return { ok: true, admin };
  };
}

/** 個人トークン（GitHub Actions・git push）。権限を確かめたあと、同じ処理の中で作る */
export function tokenGuard(state: AdminState, sites: Sites, token: string, site: string): DeployGuard {
  return guardFor(() => state.tokenUser(token), sites, site);
}

/** 管理画面のログイン。権限を確かめたあと、同じ処理の中で作る */
export function sessionGuard(state: AdminState, sites: Sites, sessionId: string | null, site: string): DeployGuard {
  return guardFor(() => state.sessionUser(sessionId), sites, site);
}
