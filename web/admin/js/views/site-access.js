import { creationOptions, credentialJSON } from "../auth.js";
import { api } from "../core/api.js";
import { fill, h } from "../core/dom.js";
import { fmtDate } from "../core/format.js";
import { siteApi } from "../core/state.js";
import { armed } from "../ui/common.js";

// ---------- サイトのログイン（パスキー） ----------
// オンにするとパスキーの登録が出て、登録できたらログインが必須になる。登録できなければオフに戻す

async function registerSitePasskey() {
  const options = await api(siteApi("/access/register/options"), { method: "POST", body: "{}" });
  const cred = await navigator.credentials.create({ publicKey: creationOptions(options) });
  await api(siteApi("/access/register/verify"), { method: "POST", body: JSON.stringify({ response: credentialJSON(cred) }) });
}

const failure = (err) => (err?.name === "NotAllowedError" ? "パスキーの登録を中止しました" : err.message);

export async function siteAccessCard() {
  const toggle = h("input", { type: "checkbox" });
  const body = h("div");
  const error = h("div", { class: "error" });
  let info = await api(siteApi("/access"));

  const load = async () => {
    info = await api(siteApi("/access"));
    render();
  };

  const render = () => {
    toggle.checked = info.enabled;
    fill(body, info.enabled ? passkeysView() : null);
  };

  const registerView = () => {
    const register = h("button", { class: "primary", text: "パスキーを登録" });
    register.addEventListener("click", async () => {
      error.textContent = "";
      register.disabled = true;
      try {
        await registerSitePasskey();
        await load();
      } catch (err) {
        error.textContent = failure(err);
        render();
      }
    });
    return h(
      "div",
      {},
      h("p", {
        class: "muted",
        text: "このサイトを開くときに使うパスキーを登録してください。登録できたら、このパスキーでログインしないとサイトを開けなくなります。",
      }),
      h("div", { class: "actions" }, register),
    );
  };

  const passkeysView = () => {
    const add = h("button", { text: "＋ パスキーを追加" });
    add.addEventListener("click", async () => {
      error.textContent = "";
      add.disabled = true;
      try {
        await registerSitePasskey();
        await load();
      } catch (err) {
        error.textContent = failure(err);
        add.disabled = false;
      }
    });
    const removable = info.passkeys.length > 1;
    return h(
      "div",
      {},
      h(
        "ul",
        { class: "passkeys" },
        ...info.passkeys.map((p, i) =>
          h(
            "li",
            { class: "passkey" },
            h(
              "div",
              { class: "grow" },
              h("div", { class: "passkey-name", text: p.name || `パスキー ${i + 1}` }),
              h("div", { class: "muted passkey-meta", text: `登録 ${fmtDate(p.createdAt).slice(0, 10)}` }),
            ),
            // 最後の 1 つは消せない（誰もログインできなくなるため）
            removable
              ? armed(h("button", { class: "ghost danger" }), "削除", "もう一度押すと削除", async () => {
                  error.textContent = "";
                  try {
                    await api(siteApi(`/access/passkeys/${encodeURIComponent(p.id)}`), { method: "DELETE" });
                    await load();
                  } catch (err) {
                    error.textContent = err.message;
                  }
                })
              : null,
          ),
        ),
      ),
      h("div", { class: "actions" }, add),
    );
  };

  // オフにするとパスキーがすべて消えるので、もう一度押して確かめる
  const disableView = () => {
    const cancel = h("button", { text: "キャンセル", onclick: render });
    const off = armed(h("button", { class: "danger" }), "オフにする", "もう一度押すとオフにする", async () => {
      error.textContent = "";
      try {
        await api(siteApi("/access"), { method: "DELETE" });
        await load();
      } catch (err) {
        error.textContent = err.message;
      }
    });
    return h(
      "div",
      {},
      h("p", { class: "muted", text: "オフにすると、登録したパスキーをすべて削除し、誰でもサイトを開けるようになります。" }),
      h("div", { class: "actions" }, off, cancel),
    );
  };

  toggle.addEventListener("change", () => {
    error.textContent = "";
    if (toggle.checked) fill(body, info.enabled ? passkeysView() : registerView());
    else fill(body, info.enabled ? disableView() : null);
  });

  render();
  return h(
    "section",
    { class: "card" },
    h("h2", { text: "ログイン" }),
    h("p", { class: "muted", text: "オンにすると、ここで登録したパスキーでログインした人だけがサイトを開けるようになります。" }),
    h("label", { class: "inline switch" }, toggle, "ログインを必須にする"),
    body,
    error,
  );
}
