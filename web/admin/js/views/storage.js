import { api } from "../core/api.js";
import { fill, h } from "../core/dom.js";
import { fmtBytes, fmtDate, prettyValue } from "../core/format.js";
import { BASE, siteApi, state } from "../core/state.js";
import { route } from "../shell.js";
import { armed, busy, chooser, emptyState, icon, pageHead } from "../ui/common.js";

export async function viewStorage(main) {
  const site = state.siteName;
  const { buckets } = await api(siteApi("/r2"));
  const page = h("div", { class: "page" }, pageHead("ストレージ"));
  if (!buckets.length) {
    page.append(
      emptyState(
        "storage",
        "R2 のバケットはまだありません",
        "wrangler の設定に r2_buckets を追加してデプロイすると、Worker が保存したファイル（オブジェクト）をここで見たり、アップロード・ダウンロードしたりできます。",
        `"r2_buckets": [\n  { "binding": "BUCKET", "bucket_name": "${site}" }\n]`,
      ),
    );
    return main.replaceChildren(page);
  }
  state.storage ??= {};
  if (state.storage.site !== site || !buckets.some((b) => b.name === state.storage.bucket)) state.storage = { site, bucket: buckets[0].name, prefix: "" };
  const bucket = buckets.find((b) => b.name === state.storage.bucket);
  const bApi = (p) => siteApi(`/r2/${encodeURIComponent(bucket.name)}${p}`);
  const go2 = (prefix) => {
    state.storage.prefix = prefix;
    route();
  };

  const error = h("div", { class: "error" });
  const list = h("div", { class: "list data-list" });
  const more = h("button", { class: "load-more", text: "さらに読み込む" });
  let cursor = null;

  // パンくず（フォルダは / 区切りのキーの先頭）
  const parts = state.storage.prefix.split("/").filter(Boolean);
  const crumbs = h(
    "nav",
    { class: "crumbs", "aria-label": "フォルダ" },
    h("button", { class: "ghost", text: bucket.name, onclick: () => go2("") }),
    ...parts.flatMap((p, i) => [
      h("span", { class: "muted", text: "/" }),
      h("button", { class: "ghost", text: p, onclick: () => go2(`${parts.slice(0, i + 1).join("/")}/`) }),
    ]),
  );

  const objectRow = (o) => {
    const item = h("div", { class: "list-item" });
    const name = o.key.slice(state.storage.prefix.length);
    const detail = h("div", { class: "data-detail", hidden: true });
    const head = h(
      "button",
      { class: "list-row data-row", "aria-expanded": "false" },
      h("span", { class: "data-key" }, icon("file"), h("span", { class: "mono", text: name })),
      h("span", { class: "muted", text: fmtBytes(o.size) }),
      h("span", { class: "muted data-exp", text: fmtDate(o.uploaded) }),
    );
    head.addEventListener("click", async () => {
      const show = detail.hidden;
      detail.hidden = !show;
      head.setAttribute("aria-expanded", String(show));
      if (!show) return;
      const download = h("a", {
        class: "button",
        href: `${BASE}/api${bApi(`/object?key=${encodeURIComponent(o.key)}`)}`,
        download: name,
        text: "ダウンロード",
      });
      const del = armed(h("button", { class: "danger" }), "削除", "もう一度押すと削除", async () => {
        try {
          await api(bApi(`/object?key=${encodeURIComponent(o.key)}`), { method: "DELETE" });
          item.remove();
        } catch (err) {
          error.textContent = err.message;
        }
      });
      const preview = h("div", {}, h("p", { class: "muted", text: "読み込み中…" }));
      fill(
        detail,
        preview,
        h(
          "dl",
          { class: "kv" },
          h("dt", { text: "キー" }),
          h("dd", { class: "mono", text: o.key }),
          h("dt", { text: "サイズ" }),
          h("dd", { text: fmtBytes(o.size) }),
          h("dt", { text: "Content-Type" }),
          h("dd", { text: o.contentType ?? "–" }),
          h("dt", { text: "アップロード" }),
          h("dd", { text: fmtDate(o.uploaded) }),
          h("dt", { text: "ETag" }),
          h("dd", { class: "mono", text: o.etag }),
          Object.keys(o.customMetadata).length ? h("dt", { text: "customMetadata" }) : null,
          Object.keys(o.customMetadata).length ? h("dd", { class: "mono", text: JSON.stringify(o.customMetadata) }) : null,
        ),
        h("div", { class: "actions" }, download, del),
      );
      try {
        const p = await api(bApi(`/preview?key=${encodeURIComponent(o.key)}`));
        fill(
          preview,
          p.text === null
            ? h("p", { class: "muted", text: "テキストではないのでプレビューできません。ダウンロードして開いてください。" })
            : h("pre", { class: "log data-value", text: prettyValue(p.text) + (p.truncated ? "\n…（先頭の 256 KiB だけを表示しています）" : "") }),
        );
      } catch (err) {
        fill(preview, h("div", { class: "error", text: err.message }));
      }
    });
    item.append(head, detail);
    return item;
  };

  let seq = 0;
  const load = async (reset) => {
    const mine = ++seq;
    more.disabled = true;
    const r = await api(
      bApi(`/objects?prefix=${encodeURIComponent(state.storage.prefix)}${!reset && cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`),
    ).finally(() => {
      if (mine === seq) more.disabled = false;
    });
    if (mine !== seq) return;
    if (reset) fill(list);
    // フォルダは 2 ページ目以降にも出てくる（キーの順に、オブジェクトと混ざって返る）
    for (const p of r.prefixes) {
      list.append(
        h(
          "div",
          { class: "list-item" },
          h(
            "button",
            { class: "list-row data-row", onclick: () => go2(p) },
            h("span", { class: "data-key" }, icon("folder"), h("span", { class: "mono", text: p.slice(state.storage.prefix.length) })),
            h("span"),
            h("span"),
          ),
        ),
      );
    }
    for (const o of r.objects) list.append(objectRow(o));
    if (reset && !r.objects.length && !r.prefixes.length) list.append(h("div", { class: "empty", text: "このフォルダにはまだ何もありません" }));
    cursor = r.cursor;
    more.hidden = !cursor;
  };
  more.addEventListener("click", () => load(false).catch((err) => (error.textContent = err.message)));

  // アップロード（今のフォルダに、ファイル名のキーで保存する）
  const fileInput = h("input", { type: "file", multiple: true, hidden: true });
  const upload = h("button", { text: "＋ アップロード", onclick: () => fileInput.click() });
  fileInput.addEventListener("change", async () => {
    error.textContent = "";
    // アップロード中に画面を移っても、選んだときのサイト・バケット・フォルダに送る
    const target = (key) => `${BASE}/api/sites/${encodeURIComponent(site)}/r2/${encodeURIComponent(bucket.name)}/object?key=${encodeURIComponent(key)}`;
    const prefix = state.storage.prefix;
    const failures = [];
    for (const file of [...fileInput.files]) {
      busy(upload, `アップロード中… ${file.name}`);
      try {
        const res = await fetch(target(prefix + file.name), {
          method: "PUT",
          body: file,
          headers: { "x-object-content-type": file.type || "application/octet-stream" },
          credentials: "same-origin",
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      } catch (err) {
        failures.push(`${file.name}: ${err.message}`);
      }
    }
    fileInput.value = "";
    upload.disabled = false;
    upload.textContent = "＋ アップロード";
    // 同じ画面にいるときだけ一覧を読み直す（エラーの表示は残す）
    if (page.isConnected) {
      error.textContent = failures.join(" / ");
      await load(true).catch((err) => (error.textContent = err.message));
    } else if (failures.length) {
      alert(`アップロードに失敗したファイルがあります\n${failures.join("\n")}`);
    }
  });

  page.append(
    h(
      "div",
      { class: "filters" },
      chooser(
        buckets.map((b) => ({ name: b.name, label: `${b.name}${b.binding ? `（${b.binding}）` : "（設定にない）"}` })),
        bucket.name,
        (name) => {
          state.storage = { site, bucket: name, prefix: "" };
          route();
        },
        "バケット",
      ),
      crumbs,
      h("span", { class: "spacer" }),
      upload,
      fileInput,
    ),
    h("p", {
      class: "muted data-summary",
      text: `バケット ${bucket.name}${bucket.binding ? `（binding: ${bucket.binding}）` : "（今の wrangler の設定にはないバケットです。データだけが残っています）"}・${bucket.count} 件・${fmtBytes(bucket.size)}`,
    }),
    list,
    more,
    error,
  );
  main.replaceChildren(page);
  await load(true);
}
