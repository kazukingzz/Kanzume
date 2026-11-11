import { api, setUnauthorizedHandler } from "./core/api.js";
import { $, h } from "./core/dom.js";
import { fmtDate } from "./core/format.js";
import { clearTimers, isAdmin, state } from "./core/state.js";
import { enterApp, go, loadOverview, setMenu, siteHash } from "./shell.js";
import { pageHead } from "./ui/common.js";

// ---------- passkey ----------

export const b64ToBuf = (s) => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0)).buffer;
};

export const bufToB64 = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export function creationOptions(json) {
  if (PublicKeyCredential.parseCreationOptionsFromJSON) return PublicKeyCredential.parseCreationOptionsFromJSON(json);
  return {
    ...json,
    challenge: b64ToBuf(json.challenge),
    user: { ...json.user, id: b64ToBuf(json.user.id) },
    excludeCredentials: (json.excludeCredentials || []).map((c) => ({ ...c, id: b64ToBuf(c.id) })),
  };
}

export function requestOptions(json) {
  if (PublicKeyCredential.parseRequestOptionsFromJSON) return PublicKeyCredential.parseRequestOptionsFromJSON(json);
  return { ...json, challenge: b64ToBuf(json.challenge), allowCredentials: (json.allowCredentials || []).map((c) => ({ ...c, id: b64ToBuf(c.id) })) };
}

export function credentialJSON(cred) {
  if (typeof cred.toJSON === "function") return cred.toJSON();
  const r = cred.response;
  const response = { clientDataJSON: bufToB64(r.clientDataJSON) };
  if (r.attestationObject) {
    response.attestationObject = bufToB64(r.attestationObject);
    response.transports = r.getTransports ? r.getTransports() : [];
  } else {
    response.authenticatorData = bufToB64(r.authenticatorData);
    response.signature = bufToB64(r.signature);
    if (r.userHandle) response.userHandle = bufToB64(r.userHandle);
  }
  return {
    id: cred.id,
    rawId: bufToB64(cred.rawId),
    type: cred.type,
    response,
    clientExtensionResults: cred.getClientExtensionResults(),
    authenticatorAttachment: cred.authenticatorAttachment,
  };
}

setUnauthorizedHandler(() => showAuth("login"));

export function showAuth(view) {
  clearTimers();
  $("app").hidden = true;
  $("auth").hidden = false;
  for (const id of ["auth-loading", "setup", "login", "invite"]) $(id).hidden = id !== view;
  if (view === "login") $("login-error").textContent = "";
}

/** パスキーを登録する。options と verify には同じ body を送る（サーバーは verify でも登録してよいかを確かめ直す） */
export async function registerPasskey(body = {}) {
  const options = await api("/register/options", { method: "POST", body: JSON.stringify(body) });
  const cred = await navigator.credentials.create({ publicKey: creationOptions(options) });
  await api("/register/verify", { method: "POST", body: JSON.stringify({ ...body, response: credentialJSON(cred) }) });
}

$("register").addEventListener("click", async () => {
  $("setup-error").textContent = "";
  try {
    await registerPasskey({ setupToken: $("setup-token").value.trim() });
    // ルートドメインはパスキーを登録してから（ログインした状態で）保存する
    let domainError = null;
    if (!$("setup-domain-field").hidden) {
      await api("/domain", { method: "POST", body: JSON.stringify({ domain: $("setup-domain").value.trim() }) }).catch((err) => (domainError = err));
    }
    await enterApp();
    if (domainError) {
      go("#/admin");
      alert(`パスキーは登録しましたが、ドメインを保存できませんでした: ${domainError.message}\n管理者設定のページで設定してください。`);
    }
  } catch (err) {
    $("setup-error").textContent = err.message;
  }
});

// ---------- 招待 ----------

export const inviteToken = () => (/^#\/invite\/([^/]+)/.exec(location.hash) || [])[1] ?? null;

export async function showInvite(token) {
  showAuth("invite");
  $("invite-error").textContent = "";
  $("invite-form").hidden = true;
  try {
    const info = await api(`/invite?token=${encodeURIComponent(token)}`);
    if (!info.valid) {
      $("invite-desc").textContent = "この招待リンクは使えません（使用済み・期限切れ・取り消し済みのいずれか）。管理者に新しいリンクを頼んでください。";
      return;
    }
    $("invite-desc").textContent =
      `サイト ${info.site} のメンバーとして参加します。パスキーを登録すると、このサイトのデプロイ・設定・削除ができるようになります（${fmtDate(info.expiresAt).slice(0, 10)} まで有効）。`;
    $("invite-form").hidden = false;
    $("invite-name").focus();
  } catch (err) {
    $("invite-desc").textContent = "";
    $("invite-error").textContent = err.message;
  }
}

$("invite-join").addEventListener("click", async () => {
  $("invite-error").textContent = "";
  const join = { inviteToken: inviteToken(), name: $("invite-name").value.trim() };
  if (!join.name) {
    $("invite-error").textContent = "名前を入力してください";
    $("invite-name").focus();
    return;
  }
  try {
    await registerPasskey(join);
    go("#/");
    await enterApp();
  } catch (err) {
    $("invite-error").textContent = err.message;
  }
});

// 登録済みの人はサインインしてから、招待のページで「参加する」を押す
$("invite-signin").addEventListener("click", (e) => {
  e.preventDefault();
  showAuth("login");
});

export async function viewInvite(main, token) {
  const page = h("div", { class: "page" }, pageHead("サイトへの招待"));
  const info = await api(`/invite?token=${encodeURIComponent(token)}`);
  const error = h("div", { class: "error" });
  if (!info.valid) {
    page.append(
      h("section", { class: "card" }, h("p", { class: "muted", text: "この招待リンクは使えません（使用済み・期限切れ・取り消し済みのいずれか）。" })),
    );
  } else if (isAdmin()) {
    page.append(
      h(
        "section",
        { class: "card" },
        h("p", {
          class: "muted",
          text: `サイト ${info.site} への招待リンクです。管理者はすべてのサイトを扱えるので、参加の必要はありません。メンバーになる人にこのリンクを渡してください。`,
        }),
      ),
    );
  } else {
    const join = h("button", { class: "primary", text: "参加する" });
    join.addEventListener("click", async () => {
      join.disabled = true;
      try {
        const { site } = await api("/invite/accept", { method: "POST", body: JSON.stringify({ token }) });
        await loadOverview();
        go(siteHash("deployments", site));
      } catch (err) {
        error.textContent = err.message;
        join.disabled = false;
      }
    });
    page.append(
      h(
        "section",
        { class: "card" },
        h("h2", { text: `サイト ${info.site}` }),
        h("p", { class: "muted", text: `${state.overview.me.name} として、このサイトのメンバーに参加します。` }),
        join,
        error,
      ),
    );
  }
  main.replaceChildren(page);
}

$("signin").addEventListener("click", async () => {
  $("login-error").textContent = "";
  try {
    const options = await api("/login/options", { method: "POST", body: "{}" });
    const cred = await navigator.credentials.get({ publicKey: requestOptions(options) });
    await api("/login/verify", { method: "POST", body: JSON.stringify({ response: credentialJSON(cred) }) });
    await enterApp();
  } catch (err) {
    $("login-error").textContent = err.message;
  }
});

$("logout").addEventListener("click", async () => {
  try {
    await api("/logout", { method: "POST", body: "{}" });
  } catch (err) {
    setMenu(false);
    $("main").querySelector(".logout-error")?.remove();
    $("main").prepend(h("div", { class: "notice logout-error", role: "alert", text: err.message }));
    return;
  }
  showAuth("login");
});
