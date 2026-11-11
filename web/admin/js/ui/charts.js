import { esc, h } from "../core/dom.js";
import { fmtCount } from "../core/format.js";

export function niceScale(v) {
  const target = Math.max(v, 1e-9) / 4;
  const exp = 10 ** Math.floor(Math.log10(target));
  const step = [1, 2, 5, 10].map((m) => m * exp).find((m) => m >= target);
  const ticks = Math.max(1, Math.ceil(v / step));
  return { max: step * ticks, step, ticks };
}

export const PAD = { l: 44, r: 8, t: 8, b: 22 };

export function frame(el, scale, fmtY, buckets, xLabel) {
  const maxY = scale.max;
  const w = el.clientWidth || 300;
  const hgt = el.clientHeight || 190;
  const iw = w - PAD.l - PAD.r;
  const ih = hgt - PAD.t - PAD.b;
  const y = (v) => PAD.t + ih - (v / maxY) * ih;
  const band = iw / buckets.length;
  let svg = "";
  for (let i = 0; i <= scale.ticks; i++) {
    const v = scale.step * i;
    const yy = Math.round(y(v)) + 0.5;
    svg += `<line class="${i ? "grid" : "baseline"}" x1="${PAD.l}" x2="${w - PAD.r}" y1="${yy}" y2="${yy}"/>`;
    svg += `<text x="${PAD.l - 6}" y="${yy + 3.5}" text-anchor="end">${esc(fmtY(v))}</text>`;
  }
  const ticks = Math.max(2, Math.min(6, Math.floor(iw / 90)));
  for (let i = 0; i < ticks; i++) {
    const idx = Math.round((i / (ticks - 1)) * (buckets.length - 1));
    const x = PAD.l + band * idx + band / 2;
    svg += `<text x="${x}" y="${hgt - 6}" text-anchor="${i === 0 ? "start" : i === ticks - 1 ? "end" : "middle"}">${esc(xLabel(buckets[idx].t))}</text>`;
  }
  return { w, hgt, iw, ih, y, band, svg };
}

export function tooltip(el, x, title, rows) {
  let tip = el.querySelector(".tooltip");
  if (!tip) {
    tip = h("div", { class: "tooltip" });
    el.append(tip);
  }
  tip.replaceChildren(
    h("div", { class: "t", text: title }),
    ...rows.map(([keyCls, label, value]) =>
      h("div", { class: "r" }, h("i", { class: `key ${keyCls}` }), h("b", { text: value }), h("span", { class: "muted", text: label })),
    ),
  );
  tip.hidden = false;
  const right = x + 12;
  const left = right + tip.offsetWidth > el.clientWidth ? x - tip.offsetWidth - 12 : right;
  tip.style.left = `${Math.max(0, left)}px`;
  tip.style.top = "4px";
}

export function hideTooltip(el) {
  const tip = el.querySelector(".tooltip");
  if (tip) tip.hidden = true;
}

export function topRounded(x, y, w, hgt, r) {
  r = Math.min(r, hgt, w / 2);
  return `M${x},${y + hgt}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt}Z`;
}

export function stackedColumns(el, buckets, series, xLabel, fmtY) {
  const f = frame(el, niceScale(Math.max(1, ...buckets.map((b) => series.reduce((n, s) => n + b[s.key], 0)))), fmtY, buckets, xLabel);
  const bw = Math.max(2, Math.min(24, f.band * 0.7));
  let marks = "";
  let hits = "";
  buckets.forEach((b, i) => {
    const x = PAD.l + f.band * i + (f.band - bw) / 2;
    let base = 0;
    const visible = series.filter((s) => b[s.key] > 0);
    visible.forEach((s, j) => {
      const v = b[s.key];
      const y0 = f.y(base);
      const y1 = f.y(base + v);
      const gap = j > 0 ? 2 : 0;
      const hgt = Math.max(1, y0 - y1 - gap);
      const top = y0 - gap - hgt;
      marks +=
        j === visible.length - 1
          ? `<path class="bar ${s.cls}" data-i="${i}" d="${topRounded(x, top, bw, hgt, 4)}"/>`
          : `<rect class="bar ${s.cls}" data-i="${i}" x="${x}" y="${top}" width="${bw}" height="${hgt}"/>`;
      base += v;
    });
    hits += `<rect class="hit" data-i="${i}" x="${PAD.l + f.band * i}" y="${PAD.t}" width="${f.band}" height="${f.ih}"/>`;
  });
  el.innerHTML = `<svg viewBox="0 0 ${f.w} ${f.hgt}" role="img" aria-label="リクエスト数の推移">${f.svg}${marks}${hits}</svg>`;
  const svg = el.querySelector("svg");
  svg.addEventListener("pointermove", (e) => {
    const i = Number(e.target.dataset?.i);
    if (Number.isNaN(i)) return hideTooltip(el);
    for (const m of svg.querySelectorAll(".bar")) m.classList.toggle("dim", Number(m.dataset.i) !== i);
    const b = buckets[i];
    tooltip(
      el,
      PAD.l + f.band * i + f.band / 2,
      xLabel(b.t),
      series.map((s) => [s.keyCls, s.label, fmtCount(b[s.key])]),
    );
  });
  svg.addEventListener("pointerleave", () => {
    for (const m of svg.querySelectorAll(".bar")) m.classList.remove("dim");
    hideTooltip(el);
  });
}

export function lineChart(el, buckets, series, xLabel, fmtY, label = "実行時間の推移") {
  const values = buckets.flatMap((b) => series.map((s) => b[s.key]).filter((v) => v !== null));
  const f = frame(el, niceScale(values.length ? Math.max(...values) : 1), fmtY, buckets, xLabel);
  const xOf = (i) => PAD.l + f.band * i + f.band / 2;
  let marks = "";
  for (const s of series) {
    let d = "";
    let pen = false;
    const dots = [];
    buckets.forEach((b, i) => {
      const v = b[s.key];
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${xOf(i).toFixed(1)},${f.y(v).toFixed(1)}`;
      const prev = buckets[i - 1]?.[s.key];
      const next = buckets[i + 1]?.[s.key];
      if ((prev === null || prev === undefined) && (next === null || next === undefined)) dots.push(i);
      pen = true;
    });
    marks += `<path class="line-${s.cls}" d="${d}"/>`;
    for (const i of dots) marks += `<circle class="dot-${s.cls}" cx="${xOf(i)}" cy="${f.y(buckets[i][s.key])}" r="4"/>`;
  }
  el.innerHTML = `<svg viewBox="0 0 ${f.w} ${f.hgt}" role="img" aria-label="${esc(label)}">${f.svg}${marks}<line class="crosshair" visibility="hidden" y1="${PAD.t}" y2="${PAD.t + f.ih}" x1="0" x2="0"/><g class="focus"></g><rect class="hit" x="${PAD.l}" y="${PAD.t}" width="${f.iw}" height="${f.ih}"/></svg>`;
  const svg = el.querySelector("svg");
  const cross = svg.querySelector(".crosshair");
  const focus = svg.querySelector(".focus");
  svg.addEventListener("pointermove", (e) => {
    const rect = svg.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * f.w;
    const i = Math.min(buckets.length - 1, Math.max(0, Math.floor((px - PAD.l) / f.band)));
    const x = xOf(i);
    cross.setAttribute("x1", x);
    cross.setAttribute("x2", x);
    cross.setAttribute("visibility", "visible");
    focus.innerHTML = series
      .filter((s) => buckets[i][s.key] !== null)
      .map((s) => `<circle class="dot-${s.cls}" cx="${x}" cy="${f.y(buckets[i][s.key])}" r="4"/>`)
      .join("");
    tooltip(
      el,
      x,
      xLabel(buckets[i].t),
      series.map((s) => [`line s${s.cls}`, s.label, fmtY(buckets[i][s.key])]),
    );
  });
  svg.addEventListener("pointerleave", () => {
    cross.setAttribute("visibility", "hidden");
    focus.innerHTML = "";
    hideTooltip(el);
  });
}
