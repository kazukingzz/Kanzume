import { api } from "../core/api.js";
import { fill, h } from "../core/dom.js";
import { fmtCount, fmtDate, fmtMs, fmtShort, fmtTime } from "../core/format.js";
import { siteApi, state } from "../core/state.js";
import { route } from "../shell.js";
import { lineChart, stackedColumns } from "../ui/charts.js";
import { loadSite, pageHead, tableView } from "../ui/common.js";

// ---------- 可観測性 ----------

export const RANGES = [
  ["1h", "1 時間"],
  ["24h", "24 時間"],
  ["3d", "3 日"],
];

export const RANGE_MS = { "1h": 3600e3, "24h": 86400e3, "3d": 3 * 86400e3 };

export async function viewObservability(main) {
  await loadSite();
  const o = state.obs;
  const page = h("div", { class: "page" });
  const body = h("div");
  const seg = (items, value, onPick) =>
    h(
      "div",
      { class: "segmented", role: "group" },
      ...items.map(([v, label]) =>
        h("button", { class: v === value ? "active" : "", "aria-pressed": String(v === value), text: label, onclick: () => onPick(v) }),
      ),
    );
  page.append(
    pageHead("可観測性", [
      seg(
        [
          ["overview", "概要"],
          ["events", "イベント"],
        ],
        o.view,
        (v) => {
          o.view = v;
          route();
        },
      ),
    ]),
    h(
      "div",
      { class: "filters" },
      seg(RANGES, o.range, (v) => {
        o.range = v;
        route();
      }),
    ),
    body,
  );
  main.replaceChildren(page);
  if (o.view === "overview") await renderMetrics(main, body);
  else await renderEvents(main, body, page.querySelector(".filters"));
}

export async function renderMetrics(main, body) {
  const load = async () => {
    const m = await api(siteApi(`/metrics?range=${state.obs.range}`));
    if (!main.current) return;
    drawMetrics(body, m);
  };
  await load();
  main.every(15_000, () => load().catch(() => {}));
}

export function drawMetrics(body, m) {
  const t = m.totals;
  const errorRate = t.requests ? (t.errors / t.requests) * 100 : 0;
  const tile = (label, value, note) =>
    h("div", { class: "tile" }, h("div", { class: "label", text: label }), h("div", { class: "value", text: value }), h("div", { class: "note", text: note }));
  const withDate = m.range !== "1h";
  const xLabel = (v) => fmtShort(v, withDate);

  const requests = h("div", { class: "chart" });
  const latency = h("div", { class: "chart" });
  body.replaceChildren(
    h(
      "div",
      { class: "tiles" },
      tile("リクエスト", fmtCount(t.requests), `Worker ${fmtCount(t.worker)} / アセット ${fmtCount(t.requests - t.worker)}`),
      tile("エラー", fmtCount(t.errors), `${errorRate.toFixed(errorRate && errorRate < 1 ? 2 : 1)}%（5xx・例外）`),
      tile("実行時間 p50", fmtMs(t.p50), `p95 ${fmtMs(t.p95)}`),
      tile("実行時間 p99", fmtMs(t.p99), `2xx ${t.statuses["2xx"]} · 3xx ${t.statuses["3xx"]} · 4xx ${t.statuses["4xx"]} · 5xx ${t.statuses["5xx"]}`),
    ),
    h(
      "div",
      { class: "charts" },
      h(
        "section",
        { class: "chart-card" },
        h("h2", { text: "リクエスト数" }),
        h("div", { class: "legend" }, h("span", {}, h("i", { class: "key s1" }), "成功"), h("span", {}, h("i", { class: "key err" }), "エラー")),
        requests,
        tableView(
          ["時刻", "成功", "エラー"],
          m.buckets.map((b) => [xLabel(b.t), b.ok, b.errors]),
        ),
      ),
      h(
        "section",
        { class: "chart-card" },
        h("h2", { text: "実行時間" }),
        h("div", { class: "legend" }, h("span", {}, h("i", { class: "key line s1" }), "p50"), h("span", {}, h("i", { class: "key line s2" }), "p99")),
        latency,
        tableView(
          ["時刻", "p50", "p99"],
          m.buckets.map((b) => [xLabel(b.t), fmtMs(b.p50), fmtMs(b.p99)]),
        ),
      ),
    ),
  );
  const draw = () => {
    stackedColumns(
      requests,
      m.buckets,
      [
        { key: "ok", label: "成功", cls: "fill-1", keyCls: "s1" },
        { key: "errors", label: "エラー", cls: "fill-err", keyCls: "err" },
      ],
      xLabel,
      (v) => fmtCount(v),
    );
    lineChart(
      latency,
      m.buckets,
      [
        { key: "p50", label: "p50", cls: "1" },
        { key: "p99", label: "p99", cls: "2" },
      ],
      xLabel,
      fmtMs,
    );
  };
  draw();
  const ro = new ResizeObserver(() => draw());
  ro.observe(requests);
}

export function statusClass(e) {
  if (e.status >= 500 || e.outcome !== "ok") return "error";
  if (e.status >= 400) return "client";
  if (e.status >= 300) return "redirect";
  return "ok";
}

export const OUTCOME = { ok: "OK", exception: "例外", exceededCpu: "時間超過", canceled: "切断" };

export async function renderEvents(main, body, filters) {
  const o = state.obs;
  const result = h(
    "select",
    { "aria-label": "結果" },
    h("option", { value: "", text: "すべての結果" }),
    h("option", { value: "ok", text: "成功のみ" }),
    h("option", { value: "error", text: "エラーのみ" }),
  );
  const kind = h(
    "select",
    { "aria-label": "種類" },
    h("option", { value: "", text: "すべての種類" }),
    h("option", { value: "worker", text: "Worker" }),
    h("option", { value: "asset", text: "アセット" }),
  );
  const q = h("input", { type: "search", placeholder: "パス・ログを検索", "aria-label": "パス・ログを検索", value: o.q });
  result.value = o.result;
  kind.value = o.kind;
  const live = h("button", { class: o.live ? "active" : "", "aria-pressed": String(o.live) }, o.live ? h("span", { class: "live-dot" }) : null, "ライブ");
  filters.append(result, kind, q, live);

  const list = h("div", { class: "events" });
  const more = h("button", { class: "more", text: "さらに読み込む" });
  body.replaceChildren(list);

  let oldest = null;
  let newest = 0;
  const params = (extra) => {
    const p = new URLSearchParams({ limit: "50", from: String(Date.now() - RANGE_MS[o.range]), ...extra });
    if (o.result) p.set("result", o.result);
    if (o.kind) p.set("kind", o.kind);
    if (o.q) p.set("q", o.q);
    return p;
  };
  const header = () =>
    h(
      "div",
      { class: "event-row head" },
      h("span", { text: "時刻" }),
      h("span", { text: "ステータス" }),
      h("span", { text: "メソッド" }),
      h("span", { text: "パス" }),
      h("span", { class: "num", text: "実行時間" }),
      h("span", { class: "num", text: "ログ" }),
    );

  const reload = async () => {
    const { events } = await api(siteApi(`/events?${params({})}`));
    list.replaceChildren(header(), ...events.map((e) => eventRow(e)));
    if (!events.length) list.append(h("div", { class: "empty", text: "この期間のイベントはありません" }));
    oldest = events.length ? events[events.length - 1].id : null;
    newest = events.length ? events[0].id : newest;
    if (events.length === 50) list.append(more);
  };

  more.addEventListener("click", async () => {
    more.disabled = true;
    try {
      const { events } = await api(siteApi(`/events?${params({ before: String(oldest) })}`));
      more.remove();
      more.textContent = "さらに読み込む";
      for (const e of events) list.append(eventRow(e));
      oldest = events.length ? events[events.length - 1].id : oldest;
      if (events.length === 50) list.append(more);
    } catch (err) {
      more.textContent = `読み込めませんでした（${err.message}）。もう一度試す`;
    } finally {
      more.disabled = false;
    }
  });
  /** 絞り込みを変えたとき。失敗したら一覧の代わりにエラーを出す */
  const refresh = () => reload().catch((err) => list.replaceChildren(h("div", { class: "notice", text: err.message })));

  const poll = async () => {
    const { events } = await api(siteApi(`/events?${params(newest ? { after: String(newest) } : {})}`));
    if (!events.length || !main.current) return;
    list.querySelector(".empty")?.remove();
    const head = list.querySelector(".event-row.head");
    for (const e of events.reverse()) head.after(eventRow(e));
    newest = Math.max(newest, ...events.map((e) => e.id));
  };

  let timer = null;
  q.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      o.q = q.value.trim();
      refresh();
    }, 300);
  });
  result.addEventListener("change", () => {
    o.result = result.value;
    refresh();
  });
  kind.addEventListener("change", () => {
    o.kind = kind.value;
    refresh();
  });
  live.addEventListener("click", () => {
    o.live = !o.live;
    route();
  });

  await reload();
  if (o.live) main.every(2000, () => poll().catch(() => {}));
}

export function eventRow(e) {
  const wrap = h("div");
  const detail = h("div", { class: "event-detail" });
  detail.hidden = true;
  const cls = statusClass(e);
  const row = h(
    "button",
    {
      class: "event-row",
      "aria-expanded": "false",
      onclick: async () => {
        const open = detail.hidden;
        detail.hidden = !open;
        row.setAttribute("aria-expanded", String(open));
        if (open && !detail.dataset.loaded) {
          detail.dataset.loaded = "1";
          detail.append(h("p", { class: "muted", text: "読み込み中…" }));
          try {
            renderEventDetail(detail, await api(siteApi(`/events/${e.id}`)));
          } catch (err) {
            detail.replaceChildren(h("div", { class: "notice", text: err.message }));
          }
        }
      },
    },
    h("span", { class: "time mono", text: fmtDate(e.ts) }),
    h("span", { class: `code-badge ${cls}`, text: e.outcome === "ok" ? String(e.status) : `${e.status} ${OUTCOME[e.outcome]}` }),
    h("span", { class: "method mono", text: e.method }),
    h("span", { class: "path mono", title: e.path, text: e.path }),
    h("span", { class: "num", text: fmtMs(e.durationMs) }),
    h("span", { class: "num logs", text: e.logCount ? String(e.logCount) : "–" }),
  );
  wrap.append(row, detail);
  return wrap;
}

export function renderEventDetail(el, e) {
  const d = e.detail;
  const kv = (obj) =>
    h("dl", { class: "kv" }, ...Object.entries(obj).flatMap(([k, v]) => [h("dt", { class: "mono", text: k }), h("dd", { class: "mono", text: v })]));
  fill(
    el,
    h("h3", { text: "概要" }),
    kv({
      時刻: fmtDate(e.ts),
      種類: e.kind === "worker" ? "Worker" : "アセット",
      結果: `${OUTCOME[e.outcome]}（${e.status}）`,
      実行時間: fmtMs(e.durationMs),
      URL: d.url,
      ...(e.release ? { リリース: e.release } : {}),
    }),
    d.exceptions.length ? h("h3", { text: "例外" }) : null,
    ...d.exceptions.map((x) => h("pre", { class: "log", text: x.stack || `${x.name}: ${x.message}` })),
    h("h3", { text: `ログ（${d.logs.length + d.droppedLogs}）` }),
    d.logs.length
      ? h(
          "div",
          { class: "mono" },
          ...d.logs.map((l) =>
            h(
              "div",
              { class: "logline" },
              h("span", { class: "ts muted", text: fmtTime(l.ts) }),
              h("span", { class: `level lv-${l.level}`, text: l.level }),
              h("span", { class: "msg", text: l.message }),
            ),
          ),
          d.droppedLogs ? h("div", { class: "muted", text: `ほか ${d.droppedLogs} 件は省略しました` }) : null,
        )
      : h("p", { class: "muted", text: "console 出力はありません" }),
    d.subrequests.length ? h("h3", { text: `サブリクエスト（${d.subrequests.length}）` }) : null,
    d.subrequests.length
      ? h(
          "table",
          { class: "mono" },
          h(
            "tbody",
            {},
            ...d.subrequests.map((s) =>
              h(
                "tr",
                {},
                h("td", { text: s.method }),
                h("td", { class: "path", text: s.url }),
                h("td", { text: s.status ?? s.error ?? "" }),
                h("td", { class: "num", text: fmtMs(s.durationMs) }),
              ),
            ),
          ),
        )
      : null,
    h("h3", { text: "リクエストヘッダ" }),
    kv(d.request),
    Object.keys(d.response).length ? h("h3", { text: "レスポンスヘッダ" }) : null,
    Object.keys(d.response).length ? kv(d.response) : null,
  );
}
