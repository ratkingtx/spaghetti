// build_html.js (v2.3a, mac-only, FIXED template literals)
// - TOP_N=30 default
// - CST/CDT axis labels
// - "Last updated" timestamp
// - Labels strategy: Option D (Extremes only: Top-5 & Bottom-5) with right gutter using annotations + arrows
import axios from "axios";
import fs from "fs-extra";
import path from "node:path";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
dayjs.extend(utc);
dayjs.extend(timezone);

const BINANCE = "https://api.binance.com";
const OUTDIR = process.env.OUTDIR || "out_spaghetti_html";
const TOP_N = parseInt(process.env.TOP_N || "30", 10);
const INTERVAL = process.env.INTERVAL || "5m"; // 1m|3m|5m|15m
const HOURS = parseInt(process.env.HOURS || "24", 10);
const MAX_KLINES_LIMIT = 1000; // Binance cap
const LABEL_BASE_ONLY = (process.env.LABEL_BASE_ONLY || "true").toLowerCase() === "true"; // base tickers (SOL) instead of SOLUSDT
const TZ = process.env.TZ_NAME || "America/Chicago"; // Show Texas time

const STABLES = new Set(["USDT","USDC","BUSD","DAI","TUSD","FDUSD","EURS","USDP","USDD","UST","USTC","PYUSD"]);
const EXCL_TOKENS = ["UP","DOWN","3L","3S","5L","5S","BULL","BEAR"];

function looksLikeUsdtSpot(sym) { return sym.endsWith("USDT"); }
function baseFromPair(sym) { return sym.endsWith("USDT") ? sym.slice(0, -4) : sym; }
function isExcluded(sym) {
  const base = baseFromPair(sym);
  if (STABLES.has(base)) return true;
  return EXCL_TOKENS.some(tok => sym.includes(tok));
}

async function fetch24hTickers() {
  const url = `${BINANCE}/api/v3/ticker/24hr`;
  const { data } = await axios.get(url, { timeout: 30000 });
  return data;
}
function topByQuoteVolume(tickers, topn=30) {
  const rows = [];
  for (const t of tickers) {
    const sym = t.symbol || "";
    if (!looksLikeUsdtSpot(sym)) continue;
    if (isExcluded(sym)) continue;
    const qv = parseFloat(t.quoteVolume || "0");
    rows.push([sym, qv]);
  }
  rows.sort((a,b) => b[1]-a[1]);
  return rows.slice(0, topn).map(r => r[0]);
}

const MINUTES = {"1m":1,"3m":3,"5m":5,"15m":15};
function computeLimit(hours, interval) {
  const mins = MINUTES[interval];
  if (!mins) throw new Error(`Unsupported interval: ${interval}`);
  const need = Math.ceil(hours*60/mins);
  return Math.min(need, MAX_KLINES_LIMIT);
}

async function fetchKlines(symbol, interval, limit) {
  const url = `${BINANCE}/api/v3/klines`;
  const params = { symbol, interval, limit };
  const { data } = await axios.get(url, { params, timeout: 30000 });
  // [openTime, open, high, low, close, volume, closeTime, ...]
  const rows = data.map(r => ({
    t: new Date(r[0]),   // UTC
    c: parseFloat(r[4])
  })).filter(x => Number.isFinite(x.c));
  return rows;
}

function toPercentSeries(rows) {
  if (!rows.length) return [];
  const base = rows[0].c;
  if (!Number.isFinite(base) || base === 0) return [];
  return rows.map(r => ({ t: r.t, y: r.c / base - 1 })); // percent (0.05 = +5%)
}

function renderHTML(traces, annotations, title, note) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<title>${title}</title>
<style>
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; padding: 0; background: #ffffff; color: #111; }
  #chart { width: 100vw; height: 95vh; }
  .header { padding: 10px 16px; background: #f6f8fa; border-bottom: 1px solid #e5e7eb; }
  .header h1 { margin: 0; font-size: 16px; font-weight: 600; }
  .note { font-size: 12px; opacity: 0.85; }
  a { color: #0969da; }
</style>
</head>
<body>
<div class="header">
  <h1>${title}</h1>
  <div class="note">${note}</div>
</div>
<div id="chart"></div>
<script src="./plotly.min.js"></script>
<script>
  const traces = ${JSON.stringify(traces)};
  const annotations = ${JSON.stringify(annotations)};
  const layout = {
    paper_bgcolor: '#ffffff',
    plot_bgcolor: '#ffffff',
    xaxis: { gridcolor: '#e5e7eb', zeroline: false, type: 'category', title: 'Time (America/Chicago)' },
    yaxis: { gridcolor: '#e5e7eb', zeroline: false, title: 'Return since first bar', tickformat: '+.1%' },
    legend: { orientation: 'h', y: -0.12 },
    margin: { t: 16, r: 120, b: 72, l: 64 },  // extra right margin to make room for annotation labels
    annotations: annotations
  };
  Plotly.newPlot('chart', traces, layout, {responsive: true});
</script>
</body>
</html>`;
}

async function main() {
  await fs.ensureDir(OUTDIR);
  const limit = computeLimit(HOURS, INTERVAL);

  console.log(`Fetching 24h tickers...`);
  const tickers = await fetch24hTickers();
  const syms = topByQuoteVolume(tickers, TOP_N);
  console.log(`Symbols (${syms.length}):`, syms.join(", "));

  const traces = [];
  const csvHeader = ["time", ...syms];
  const csvRows = new Map(); // time -> values[]
  const endVals = []; // {i, label, lastX, lastY}

  for (let i=0;i<syms.length;i++) {
    const symbol = syms[i];
    const label = LABEL_BASE_ONLY ? symbol.replace(/USDT$/,"") : symbol;
    try {
      const rows = await fetchKlines(symbol, INTERVAL, limit);
      const pct = toPercentSeries(rows);
      if (!pct.length) continue;

      // CST string x labels for all
      const xStrs = pct.map(p => dayjs(p.t).tz(TZ).format("YYYY-MM-DD HH:mm") + " CT");
      const y = pct.map(p => p.y);

      // Fill CSV rows (keyed by CST strings)
      for (let idx=0; idx<pct.length; idx++) {
        const tKey = xStrs[idx];
        if (!csvRows.has(tKey)) csvRows.set(tKey, Array(syms.length).fill(""));
        const arr = csvRows.get(tKey); arr[i] = y[idx].toFixed(6);
      }

      traces.push({
        type: "scatter",
        mode: "lines",
        name: label,
        x: xStrs,
        y,
        line: { width: 1.3 }
      });

      endVals.push({ i, label, lastX: xStrs[xStrs.length-1], lastY: y[y.length-1] });
      await new Promise(r => setTimeout(r, 30));
    } catch (e) {
      console.warn(`[warn] ${symbol}: ${e.message}`);
    }
  }

  // Select extremes: Top-5 and Bottom-5 by lastY
  endVals.sort((a,b) => b.lastY - a.lastY);
  const topK = 5, botK = 5;
  const selected = endVals.slice(0, topK).concat(endVals.slice(-botK));
  // Annotations with arrows to the right (gutter)
  const annotations = selected.map(s => ({
    x: s.lastX,
    y: s.lastY,
    xref: "x",
    yref: "y",
    text: `${s.label}  ${(s.lastY*100).toFixed(1)}%`,
    showarrow: true,
    arrowhead: 0,
    arrowcolor: "#999",
    ax: 60,   // shift text 60px to the right
    ay: 0,
    align: "left",
    font: { size: 11, color: "#111" },
    bgcolor: "#fff",
    bordercolor: "#e5e7eb",
    borderwidth: 1
  }));

  // Write CSV
  const csvPath = path.join(OUTDIR, `spaghetti_${INTERVAL}_${HOURS}h.csv`);
  const times = Array.from(csvRows.keys()).sort();
  const lines = [csvHeader.join(",")];
  for (const T of times) lines.push([T, ...csvRows.get(T)].join(","));
  await fs.writeFile(csvPath, lines.join("\n"), "utf8");
  console.log("Saved CSV:", csvPath);

  // Plotly bundle
  const plotlySrc = path.resolve("node_modules/plotly.js-dist-min/plotly.min.js");
  const plotlyDst = path.join(OUTDIR, "plotly.min.js");
  await fs.copy(plotlySrc, plotlyDst);

  const generatedAt = dayjs().tz(TZ).format("YYYY-MM-DD HH:mm:ss z");
  const title = `Top ${syms.length} by 24h volume — Normalized % (${INTERVAL}, ~${HOURS}h) [Binance USDT]`;
  const note = `Extremes labeled (Top-5 & Bottom-5) with right-gutter arrows; last updated: ${generatedAt} (${TZ}).`;
  const html = renderHTML(traces, annotations, title, note);
  const htmlPath = path.join(OUTDIR, "spaghetti.html");
  await fs.writeFile(htmlPath, html, "utf8");
  console.log("Saved HTML:", htmlPath);
}

main().catch(err => { console.error(err); process.exit(1); });
