import { creationOptions, credentialJSON } from "../auth.js";
import { api } from "../core/api.js";
import { fill, h } from "../core/dom.js";
import { fmtDate } from "../core/format.js";
import { siteApi } from "../core/state.js";
import { armed } from "../ui/common.js";

// ---------- サイトのログイン（パスキー） ----------
// パスキーが 1 つでもあればログインが必須になり、すべて削除すると誰でも開けるようになる

async function registerSitePasskey() {
  const options = await api(siteApi("/access/register/options"), { method: "POST", body: "{}" });
  const cred = await navigator.credentials.create({ publicKey: creationOptions(options) });
  await api(siteApi("/access/register/verify"), { method: "POST", body: JSON.stringify({ response: credentialJSON(cred) }) });
}

const failure = (err) => (err?.name === "NotAllowedError" ? "パスキーの登録を中止しました" : err.message);

export async function siteAccessCard() {
  const note = h("p", { class: "muted" });
  const list = h("ul", { class: "passkeys" });
  const add = h("button");
  const error = h("div", { class: "error" });
  let info;

  const load = async () => {
    info = await api(siteApi("/access"));
    render();
  };

  const render = () => {
    const { passkeys } = info;
    add.textContent = passkeys.length ? "＋ パスキーを追加" : "＋ パスキーを登録";
    add.disabled = false;
    note.textContent = passkeys.length
      ? "登録したパスキーでログインした人だけがサイトを開けます。すべて削除すると、誰でも開けるようになります。"
      : info.enabled
        ? "ログインが必須のままパスキーがない（設定が読めない、または登録したメンバーが外れた）ため、今は誰もサイトを開けません。パスキーを登録し直してください。"
        : "パスキーを登録すると、そのパスキーでログインした人だけがサイトを開けるようになります。今は誰でも開けます。";
    list.hidden = !passkeys.length;
    fill(
      list,
      ...passkeys.map((p, i) =>
        h(
          "li",
          { class: "passkey" },
          h(
            "div",
            { class: "grow" },
            h("div", { class: "passkey-name", text: p.name || `パスキー ${i + 1}` }),
            h("div", { class: "muted passkey-meta", text: `登録 ${fmtDate(p.createdAt).slice(0, 10)}` }),
          ),
          armed(
            h("button", { class: "ghost danger" }),
            "削除",
            passkeys.length === 1 ? "もう一度押すと削除（誰でも開けるようになります）" : "もう一度押すと削除",
            async () => {
              error.textContent = "";
              try {
                await api(siteApi(`/access/passkeys/${encodeURIComponent(p.id)}`), { method: "DELETE" });
                await load();
              } catch (err) {
                error.textContent = err.message;
              }
            },
          ),
        ),
      ),
    );
  };

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

  await load();
  return h("section", { class: "card" }, h("h2", { text: "ログイン" }), note, list, h("div", { class: "actions" }, add), error);
}
