export const fmtDate = (v) =>
  new Date(v).toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

export const fmtTime = (v) => new Date(v).toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", second: "2-digit" });

export const fmtShort = (v, withDate) =>
  new Date(v).toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    ...(withDate ? { month: "numeric", day: "numeric" } : {}),
    hour: "2-digit",
    minute: "2-digit",
  });

export function fmtAgo(v) {
  const s = Math.round((Date.now() - new Date(v).getTime()) / 1000);
  if (s < 60) return `${Math.max(s, 0)} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 時間前`;
  return `${Math.floor(s / 86400)} 日前`;
}

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

export function fmtMs(v) {
  if (v === null || v === undefined) return "–";
  if (v >= 1000) return `${(v / 1000).toFixed(2)} s`;
  if (v >= 100) return `${Math.round(v)} ms`;
  return `${v.toFixed(1)} ms`;
}

export function fmtCount(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString("ja-JP");
}

export const fmtPct = (v) => (v === null || v === undefined ? "–" : `${v < 10 ? v.toFixed(1) : Math.round(v)}%`);

export const fmtCores = (v) =>
  v === null || v === undefined ? "–" : v < 1 ? v.toFixed(3).replace(/0+$/, "").replace(/\.$/, "") : v.toFixed(2).replace(/\.?0+$/, "");

export const fmtMiB = (n) => (n === null || n === undefined ? "–" : `${(n / 1024 / 1024).toFixed(n < 100 * 1024 * 1024 ? 1 : 0)} MiB`);

export const fmtExpiration = (sec) => (sec ? `${fmtDate(sec * 1000)} に期限切れ` : "期限なし");

export const prettyValue = (text) => {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
};
