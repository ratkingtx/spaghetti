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

const BINANCE_BASES = [process.env.BINANCE_BASE || "https://api.binance.com", "https://api.binance.us"]; // try .com then .us
const OUTDIR = process.env.OUTDIR || "out_spaghetti_html";
const TOP_N = parseInt(process.env.TOP_N || "50", 10);
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

async function binanceGet(pathname, params) {
  let lastErr = null;
  for (const base of BINANCE_BASES) {
    try {
      const url = `${base}${pathname}`;
      const { data } = await axios.get(url, { params, timeout: 30000, headers: { 'User-Agent': 'spaghetti-html/2.3a (+mac)' } });
      return data;
    } catch (e) {
      lastErr = e;
      if (e?.response?.status) continue; // try next base on HTTP errors
    }
  }
  throw lastErr || new Error("All Binance bases failed");
}

async function fetch24hTickers() {
  return binanceGet(`/api/v3/ticker/24hr`);
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
  const params = { symbol, interval, limit };
  const data = await binanceGet(`/api/v3/klines`, params);
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

function renderHTML(traces, annotations, title, note, xTickVals, xTickText, retRows) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<title>${title}</title>
<style>
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; padding: 0; background: #ffffff; color: #111; }
  .container { display: flex; gap: 12px; padding: 12px; height: calc(100vh - 60px); box-sizing: border-box; }
  #chart { flex: 1; min-width: 0; height: 100%; }
  .header { padding: 10px 16px; background: #f6f8fa; border-bottom: 1px solid #e5e7eb; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .header h1 { margin: 0; font-size: 16px; font-weight: 600; }
  .spacer { flex: 1; }
  .note { font-size: 12px; opacity: 0.85; }
  a { color: #0969da; }
  .btn { appearance: none; border: 1px solid #d0d7de; background: #f6f8fa; color: #111; padding: 6px 10px; border-radius: 6px; font-size: 12px; cursor: pointer; }
  .btn:disabled { opacity: 0.6; cursor: default; }
  .sidebar { width: 240px; max-width: 280px; border: 1px solid #e5e7eb; border-radius: 8px; padding: 8px; overflow: auto; background: #fff; }
  .sidebar h2 { margin: 4px 4px 8px 4px; font-size: 13px; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { padding: 6px 8px; border-bottom: 1px solid #f0f2f5; text-align: left; }
  th:nth-child(2), td:nth-child(2) { text-align: right; }
  tr:hover { background: #fafbfc; }
  .pos { color: #0a7f3f; }
  .neg { color: #b42318; }
</style>
</head>
<body>
<div class="header">
  <h1>${title}</h1>
  <div class="spacer"></div>
  <button id="refreshBtn" class="btn">Refresh</button>
  <div class="note" id="note">${note}</div>
</div>
<div class="container">
  <aside class="sidebar">
    <h2>Returns (CT)</h2>
    <table>
      <thead><tr><th>Ticker</th><th>Return</th></tr></thead>
      <tbody id="retTbody"></tbody>
    </table>
  </aside>
  <div id="chart"></div>
 </div>
<script src="./plotly.min.js"></script>
<script>
  const traces = ${JSON.stringify(traces)};
  const annotations = ${JSON.stringify(annotations)};
  const CONFIG = {
    BINANCE_BASES: ${JSON.stringify(BINANCE_BASES)},
    TOP_N: ${TOP_N},
    INTERVAL: ${JSON.stringify(INTERVAL)},
    HOURS: ${HOURS},
    LABEL_BASE_ONLY: ${JSON.stringify(LABEL_BASE_ONLY)},
    TZ: ${JSON.stringify(TZ)}
  };
  const initialReturns = ${JSON.stringify(retRows)};
  const layout = {
    paper_bgcolor: '#ffffff',
    plot_bgcolor: '#ffffff',
    xaxis: { gridcolor: '#e5e7eb', showgrid: true, zeroline: false, type: 'date', title: 'Time (America/Chicago)', tickmode: 'array', tickvals: ${JSON.stringify(xTickVals)}, ticktext: ${JSON.stringify(xTickText)} },
    yaxis: { gridcolor: '#e5e7eb', zeroline: false, title: 'Return since first bar', tickformat: '+.1%' },
    legend: { orientation: 'h', y: -0.12 },
    margin: { t: 16, r: 120, b: 72, l: 64 },  // extra right margin to make room for annotation labels
    annotations: annotations
  };
  Plotly.newPlot('chart', traces, layout, {responsive: true});

  async function binanceGet(path, params) {
    const qs = params ? ('?' + new URLSearchParams(params)) : '';
    let lastErr = null;
    for (const base of CONFIG.BINANCE_BASES) {
      try {
        const res = await fetch(base + path + qs, { headers: { 'Accept': 'application/json' } });
        if (!res.ok) { lastErr = new Error('HTTP ' + res.status); continue; }
        return res.json();
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('All Binance bases failed');
  }

  const MINUTES = { '1m':1, '3m':3, '5m':5, '15m':15 };
  function computeLimit(hours, interval) {
    const mins = MINUTES[interval];
    const need = Math.ceil(hours*60/mins);
    return Math.min(need, ${MAX_KLINES_LIMIT});
  }

  function formatTimeToTZ(date) {
    return new Intl.DateTimeFormat('en-US', { hour:'2-digit', minute:'2-digit', hour12:false, timeZone: CONFIG.TZ }).format(date);
  }

  function toPercentSeries(rows) {
    if (!rows.length) return [];
    const base = rows[0].c;
    if (!Number.isFinite(base) || base === 0) return [];
    return rows.map(r => ({ t: r.t, y: r.c / base - 1 }));
  }

  function looksLikeUsdtSpot(sym) { return sym.endsWith('USDT'); }
  const STABLES = new Set(${JSON.stringify(Array.from(new Set(["USDT","USDC","BUSD","DAI","TUSD","FDUSD","EURS","USDP","USDD","UST","USTC","PYUSD"])))});
  const EXCL_TOKENS = ${JSON.stringify(["UP","DOWN","3L","3S","5L","5S","BULL","BEAR"])};
  function baseFromPair(sym) { return sym.endsWith('USDT') ? sym.slice(0, -4) : sym; }
  function isExcluded(sym) { const base = baseFromPair(sym); if (STABLES.has(base)) return true; return EXCL_TOKENS.some(tok => sym.includes(tok)); }

  async function generateData() {
    const limit = computeLimit(CONFIG.HOURS, CONFIG.INTERVAL);
    const tickers = await binanceGet('/api/v3/ticker/24hr');
    const symbols = [];
    for (const t of tickers) {
      const sym = t.symbol || '';
      if (!looksLikeUsdtSpot(sym)) continue;
      if (isExcluded(sym)) continue;
      const qv = parseFloat(t.quoteVolume || '0');
      symbols.push([sym, qv]);
    }
    symbols.sort((a,b) => b[1]-a[1]);
    const syms = symbols.slice(0, CONFIG.TOP_N).map(r => r[0]);

    const traces = [];
    const endVals = [];
    let xTimesRef = null;
    for (let i=0;i<syms.length;i++) {
      const symbol = syms[i];
      const label = CONFIG.LABEL_BASE_ONLY ? symbol.replace(/USDT$/,'') : symbol;
      try {
        const kl = await binanceGet('/api/v3/klines', { symbol, interval: CONFIG.INTERVAL, limit });
        const rows = kl.map(r => ({ t: new Date(r[0]), c: parseFloat(r[4]) })).filter(x => Number.isFinite(x.c));
        const pct = toPercentSeries(rows);
        if (!pct.length) continue;
        const xTimes = pct.map(p => p.t);
        const y = pct.map(p => p.y);
        traces.push({ type: 'scatter', mode: 'lines', name: label, x: xTimes, y, line: { width: 1.3 } });
        endVals.push({ label, lastX: xTimes[xTimes.length-1], lastY: y[y.length-1] });
        if (!xTimesRef) xTimesRef = xTimes;
      } catch (e) { /* ignore one-off errors */ }
    }
    endVals.sort((a,b) => b.lastY - a.lastY);
    const topK = 5, botK = 5;
    const selected = endVals.slice(0, topK).concat(endVals.slice(-botK));
    const annotations = selected.map(s => ({ x: s.lastX, y: s.lastY, xref: 'x', yref: 'y', text: s.label + '  ' + (s.lastY*100).toFixed(1) + '%', showarrow: true, arrowhead: 0, arrowcolor: '#999', ax: 60, ay: 0, align: 'left', font: { size: 11, color: '#111' }, bgcolor: '#fff', bordercolor: '#e5e7eb', borderwidth: 1 }));

    const updatedAt = new Date();
    const tzFmt = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false, timeZone: CONFIG.TZ });
    const note = 'Extremes labeled (Top-5 & Bottom-5) with right-gutter arrows; last updated: ' + tzFmt.format(updatedAt) + ' (' + CONFIG.TZ + ').';
    function isTopOfHourInTZ(date) {
      return new Intl.DateTimeFormat('en-US', { minute: '2-digit', timeZone: CONFIG.TZ }).format(new Date(date)) === '00';
    }
    const xTickVals = (xTimesRef || []).filter(isTopOfHourInTZ).map(d => new Date(d).toISOString());
    const xTickText = (xTimesRef || []).filter(isTopOfHourInTZ).map(d => new Intl.DateTimeFormat('en-US', { hour:'2-digit', minute:'2-digit', hour12:false, timeZone: CONFIG.TZ }).format(new Date(d)));
    const returns = endVals
      .slice()
      .sort((a,b) => b.lastY - a.lastY)
      .map(s => ({ label: s.label, pct: s.lastY }));
    return { traces, annotations, note, xTickVals, xTickText, returns };
  }
  function renderTable(rows) {
    const tb = document.getElementById('retTbody');
    const sorted = (rows || []).slice().sort((a,b) => b.pct - a.pct);
    let html = '';
    for (const r of sorted) {
      const pct = (r.pct * 100).toFixed(1) + '%';
      const cls = r.pct >= 0 ? 'pos' : 'neg';
      html += '<tr><td>' + r.label + '</td><td class="' + cls + '">' + pct + '</td></tr>';
    }
    tb.innerHTML = html;
  }
  renderTable(initialReturns);

  const btn = document.getElementById('refreshBtn');
  const noteEl = document.getElementById('note');
  btn?.addEventListener('click', async () => {
    btn.disabled = true; const old = btn.textContent; btn.textContent = 'Refreshing…';
    try {
      const res = await generateData();
      layout.annotations = res.annotations;
      layout.xaxis.tickmode = 'array';
      layout.xaxis.tickvals = res.xTickVals;
      layout.xaxis.ticktext = res.xTickText;
      noteEl.textContent = res.note;
      await Plotly.react('chart', res.traces, layout, {responsive: true});
      renderTable(res.returns);
    } catch (e) {
      alert('Refresh failed: ' + (e?.message || e));
    } finally { btn.disabled = false; btn.textContent = old; }
  });

  // Auto-refresh on first load
  (async function autoRefreshOnLoad(){
    try {
      btn?.setAttribute('disabled', 'disabled');
      const res = await generateData();
      layout.annotations = res.annotations;
      layout.xaxis.tickmode = 'array';
      layout.xaxis.tickvals = res.xTickVals;
      layout.xaxis.ticktext = res.xTickText;
      noteEl.textContent = res.note;
      await Plotly.react('chart', res.traces, layout, {responsive: true});
      renderTable(res.returns);
    } catch (e) {
      console.warn('Auto-refresh failed:', e);
    } finally {
      if (btn) btn.removeAttribute('disabled');
    }
  })();
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

      // Date x values for proper hourly ticks
      const xTimes = pct.map(p => p.t);
      const y = pct.map(p => p.y);

      // Fill CSV rows (keyed by local time strings for readability)
      for (let idx=0; idx<pct.length; idx++) {
        const tKey = dayjs(pct[idx].t).tz(TZ).format("YYYY-MM-DD HH:mm") + " CT";
        if (!csvRows.has(tKey)) csvRows.set(tKey, Array(syms.length).fill(""));
        const arr = csvRows.get(tKey); arr[i] = y[idx].toFixed(6);
      }

      traces.push({
        type: "scatter",
        mode: "lines",
        name: label,
        x: xTimes,
        y,
        line: { width: 1.3 }
      });

      endVals.push({ i, label, lastX: xTimes[xTimes.length-1], lastY: y[y.length-1] });
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
  const xTimesRef = traces.length ? traces[0].x : [];
  const xTickVals = xTimesRef.filter(d => dayjs(d).tz(TZ).minute() === 0).map(d => new Date(d).toISOString());
  const xTickText = xTimesRef.filter(d => dayjs(d).tz(TZ).minute() === 0).map(d => dayjs(d).tz(TZ).format("HH:mm"));
  const retRows = endVals
    .slice()
    .sort((a,b) => b.lastY - a.lastY)
    .map(s => ({ label: s.label, pct: s.lastY }));
  const html = renderHTML(traces, annotations, title, note, xTickVals, xTickText, retRows);
  const htmlPath = path.join(OUTDIR, "spaghetti.html");
  await fs.writeFile(htmlPath, html, "utf8");
  console.log("Saved HTML:", htmlPath);
}

main().catch(err => { console.error(err); process.exit(1); });
