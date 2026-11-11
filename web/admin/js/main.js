import { inviteToken, showAuth, showInvite } from "./auth.js";
import { api } from "./core/api.js";
import { $ } from "./core/dom.js";
import { enterApp } from "./shell.js";

// ---------- start ----------

(async () => {
  try {
    const s = await api("/state");
    if (s.authenticated) await enterApp();
    else {
      $("setup-domain-field").hidden = !!s.domainFromEnv;
      $("setup-domain").value = location.host;
      const token = inviteToken();
      if (token && s.registered) await showInvite(token);
      else showAuth(s.registered ? "login" : "setup");
    }
  } catch (err) {
    showAuth("login");
    $("login-error").textContent = err.message;
  }
})();
