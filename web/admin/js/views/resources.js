import { api } from "../core/api.js";
import { fill, h } from "../core/dom.js";
import { fmtCores, fmtMiB, fmtPct, fmtTime } from "../core/format.js";
import { state } from "../core/state.js";
import { lineChart } from "../ui/charts.js";
import { pageHead, tableView } from "../ui/common.js";

// ---------- resources ----------

export const SOURCE_NOTE = {
  cgroup2: "コンテナ（cgroup v2）の値です。",
  cgroup1: "コンテナ（cgroup v1）の値です。",
  process: "cgroup を読めないため、Node プロセスとマシン全体の値を表示しています。",
};

export async function viewResources(main) {
  const page = h("div", { class: "page" });
  const body = h("div");
  page.append(pageHead("リソース"), body);
  main.replaceChildren(page);
  let draw = null;
  const load = async () => {
    const r = await api("/resources");
    if (!main.current) return;
    draw = drawResources(body, r, draw);
  };
  await load();
  main.every(5000, () => load().catch(() => {}));
}

export function drawResources(body, r, prev) {
  const { cpu: cpuLimit, memory: memLimit } = r.limits;
  const latest = r.samples.at(-1);
  // 上限がなければ docker stats と同じく 1 コア = 100% で表す
  const cpuPct = (v) => (v === null || v === undefined ? null : (v / (cpuLimit ?? 1)) * 100);
  const buckets = r.samples.map((s) => ({ t: s.t, cpu: cpuPct(s.cpu), memory: s.memory / 1024 / 1024, heap: s.heap / 1024 / 1024 }));
  const peakCpu = Math.max(0, ...buckets.map((b) => b.cpu ?? 0));
  const peakMem = Math.max(0, ...r.samples.map((s) => s.memory));
  const workers = r.workers ?? [];
  const workerRss = workers.reduce((sum, w) => sum + (w.rss ?? 0), 0);
  const tile = (label, value, note) =>
    h("div", { class: "tile" }, h("div", { class: "label", text: label }), h("div", { class: "value", text: value }), h("div", { class: "note", text: note }));
  const xLabel = (v) => fmtTime(v);

  if (!prev) {
    const cpu = h("div", { class: "chart" });
    const memory = h("div", { class: "chart" });
    const tiles = h("div", { class: "tiles" });
    const tables = [h("div"), h("div")];
    const workers = h("div");
    body.replaceChildren(
      tiles,
      h(
        "div",
        { class: "charts" },
        h(
          "section",
          { class: "chart-card" },
          h("h2", { text: "CPU" }),
          h("div", { class: "legend" }, h("span", {}, h("i", { class: "key line s1" }), cpuLimit ? "上限に対する使用率" : "使用率（1 コア = 100%）")),
          cpu,
          tables[0],
        ),
        h(
          "section",
          { class: "chart-card" },
          h("h2", { text: "メモリ" }),
          h(
            "div",
            { class: "legend" },
            h("span", {}, h("i", { class: "key line s1" }), "コンテナ"),
            h("span", {}, h("i", { class: "key line s2" }), "JS ヒープ"),
          ),
          memory,
          tables[1],
        ),
      ),
      workers,
      h("p", {
        class: "muted hint",
        text: `${SOURCE_NOTE[r.source]}${r.limits.cpuRaw ? `CPU の上限は ${r.limits.cpuRaw} から計算した、実際にかかっている上限です（ホスティングの公称値と違うことがあります）。` : ""}${Math.round(r.intervalMs / 1000)} 秒ごとに計測した直近 30 分ぶんを表示します（サーバーを再起動すると消えます）。`,
      }),
    );
    prev = { cpu, memory, tiles, tables, workers, data: null };
    new ResizeObserver(() => prev.data && prev.render()).observe(cpu);
  }
  prev.data = { buckets, xLabel };
  prev.render = () => {
    const { buckets, xLabel } = prev.data;
    if (!buckets.length) return;
    lineChart(prev.cpu, buckets, [{ key: "cpu", label: "CPU", cls: "1" }], xLabel, fmtPct, "CPU 使用率の推移");
    lineChart(
      prev.memory,
      buckets,
      [
        { key: "memory", label: "コンテナ", cls: "1" },
        { key: "heap", label: "JS ヒープ", cls: "2" },
      ],
      xLabel,
      (v) => `${Math.round(v)} MiB`,
      "メモリ使用量の推移",
    );
  };
  fill(
    prev.tiles,
    tile(
      "CPU",
      fmtPct(cpuPct(latest?.cpu)),
      cpuLimit ? `${fmtCores(latest?.cpu)} / ${fmtCores(cpuLimit)} CPU` : `${fmtCores(latest?.cpu)} CPU（上限なし・1 コア = 100%）`,
    ),
    tile("CPU（30 分の最大）", fmtPct(peakCpu), `${fmtCores((peakCpu / 100) * (cpuLimit ?? 1))} CPU`),
    tile(
      "メモリ",
      fmtMiB(latest?.memory),
      `${memLimit ? `上限 ${fmtMiB(memLimit)}（${fmtPct((latest.memory / memLimit) * 100)}）` : "上限なし"} · 30 分の最大 ${fmtMiB(peakMem)}`,
    ),
    tile("Node プロセス", fmtMiB(latest?.rss), `JS ヒープ ${fmtMiB(latest?.heap)}`),
  );
  fill(
    prev.workers,
    h(
      "section",
      { class: "card workers-card" },
      h(
        "div",
        { class: "card-head" },
        h("h2", { text: "Worker のプロセス" }),
        h("span", { class: "muted", text: workers.length ? `${workers.length} 個 · 合計 ${fmtMiB(workerRss)}` : "0 個" }),
      ),
      h("p", {
        class: "muted hint",
        text: `動的サイト ${state.sites.sites.filter((x) => x.kind === "dynamic").length} 個・静的サイト ${state.sites.sites.filter((x) => x.kind === "static").length} 個。Worker 付きのサイトは、サイトごとに別のユーザーの子プロセスで動きます。しばらく使われないと止まり、次のアクセスで起動します。静的サイトはプロセスを使いません。`,
      }),
      workers.length
        ? h(
            "div",
            { class: "scroll" },
            h(
              "table",
              {},
              h("thead", {}, h("tr", {}, h("th", { text: "サイト" }), h("th", { class: "num", text: "PID" }), h("th", { class: "num", text: "メモリ" }))),
              h(
                "tbody",
                {},
                ...workers.map((w) =>
                  h("tr", {}, h("td", { text: w.site }), h("td", { class: "num", text: String(w.pid) }), h("td", { class: "num", text: fmtMiB(w.rss) })),
                ),
              ),
            ),
          )
        : null,
    ),
  );
  const keepOpen = (el) => el.querySelector("details")?.open;
  const [t0, t1] = prev.tables;
  const o0 = keepOpen(t0);
  const o1 = keepOpen(t1);
  fill(
    t0,
    tableView(
      ["時刻", "CPU"],
      buckets.map((b) => [xLabel(b.t), fmtPct(b.cpu)]),
    ),
  );
  fill(
    t1,
    tableView(
      ["時刻", "コンテナ", "JS ヒープ"],
      r.samples.map((s) => [xLabel(s.t), fmtMiB(s.memory), fmtMiB(s.heap)]),
    ),
  );
  if (o0) t0.querySelector("details").open = true;
  if (o1) t1.querySelector("details").open = true;
  prev.render();
  return prev;
}
