import { BASE } from "./state.js";

/** ログインが切れていたときに呼ぶ（auth.js がログイン画面を出す） */
let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

/** API のエラー。status と、サーバーが返した本文（exists などのフラグ）を持つ */
export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(`${BASE}/api${path}`, {
      ...options,
      headers: { "content-type": "application/json", ...(options.headers || {}) },
      credentials: "same-origin",
    });
  } catch {
    // 「Failed to fetch」はサーバーから応答がなかったとき（再起動中・ネットワークの切断）に出る
    throw new Error("サーバーに接続できませんでした。サーバーが再起動中かもしれません。しばらく待ってからページを再読み込みしてください。");
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith("/state")) {
    onUnauthorized();
    throw new ApiError("ログインしてください", 401, data);
  }
  if (!res.ok) throw new ApiError(data.error || `HTTP ${res.status}`, res.status, data);
  return data;
}
