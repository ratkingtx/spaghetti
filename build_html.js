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
const TOP_N = parseInt(process.env.TOP_N || "30", 10);
const INTERVAL = process.env.INTERVAL || "5m"; // 1m|3m|5m|15m
const HOURS = parseInt(process.env.HOURS || "24", 10);
const MAX_KLINES_LIMIT = 1000; // Binance cap
const LABEL_BASE_ONLY = (process.env.LABEL_BASE_ONLY || "true").toLowerCase() === "true"; // base tickers (SOL) instead of SOLUSDT
const TZ = process.env.TZ_NAME || "America/Chicago"; // Show Texas time
const VOLUME_PERIOD = (process.env.VOLUME_PERIOD || "7d").toLowerCase(); // 24h|7d|30d

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
async function sumDailyQuoteVolume(symbol, days) {
  const data = await binanceGet(`/api/v3/klines`, { symbol, interval: '1d', limit: days });
  let sum = 0;
  for (const k of data) {
    const quoteVol = parseFloat(k[7] || '0');
    if (Number.isFinite(quoteVol)) sum += quoteVol;
  }
  return sum;
}

async function topSymbolsByVolumePeriod(tickers, topn, period) {
  // Build candidate list from 24h tickers (has all USDT symbols)
  const candidates = [];
  for (const t of tickers) {
    const sym = t.symbol || '';
    if (!looksLikeUsdtSpot(sym)) continue;
    if (isExcluded(sym)) continue;
    const qv24h = parseFloat(t.quoteVolume || '0');
    candidates.push([sym, qv24h]);
  }
  candidates.sort((a,b) => b[1]-a[1]);
  if (period === '24h') {
    return candidates.slice(0, topn).map(r => r[0]);
  }
  const days = period === '7d' ? 7 : 30;
  const subset = candidates.slice(0, Math.max(200, topn));
  const scored = [];
  for (let i=0;i<subset.length;i++) {
    const sym = subset[i][0];
    try {
      const sum = await sumDailyQuoteVolume(sym, days);
      scored.push([sym, sum]);
      await new Promise(r => setTimeout(r, 20));
    } catch (e) {
      // ignore individual failures
    }
  }
  scored.sort((a,b) => b[1]-a[1]);
  return scored.slice(0, topn).map(r => r[0]);
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

function renderHTML(traces, annotations, title, note, xTickVals, xTickText, retRows, xAxisRange) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<title>${title}</title>
<style>
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; padding: 0; background: #ffffff; color: #111; }
  .container { display: flex; gap: 12px; padding: 12px; height: calc(100vh - 60px); box-sizing: border-box; }
  #chart { flex: 1; min-width: 0; height: 100%; position: relative; }
  .y-handle { position: absolute; left: 0; top: 0; width: 12px; height: 100%; cursor: ns-resize; background: transparent; }
  .y-handle:hover { background: rgba(0,0,0,0.02); }
  .header { padding: 10px 16px; background: #f6f8fa; border-bottom: 1px solid #e5e7eb; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .header h1 { margin: 0; font-size: 16px; font-weight: 600; }
  .spacer { flex: 1; }
  .note { font-size: 12px; opacity: 0.85; }
  a { color: #0969da; }
  .btn { appearance: none; border: 1px solid #d0d7de; background: #f6f8fa; color: #111; padding: 6px 10px; border-radius: 6px; font-size: 12px; cursor: pointer; }
  .btn:disabled { opacity: 0.6; cursor: default; }
  .btn-sm { padding: 4px 8px; font-size: 11px; }
  .sidebar { width: 240px; max-width: 280px; border: 1px solid #e5e7eb; border-radius: 8px; padding: 8px; overflow: auto; background: #fff; }
  .sidebar h2 { margin: 4px 4px 8px 4px; font-size: 13px; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { padding: 6px 8px; border-bottom: 1px solid #f0f2f5; text-align: left; }
  th:nth-child(2), td:nth-child(2) { text-align: right; }
  tr:hover { background: #fafbfc; }
  .pos { color: #0a7f3f; }
  .neg { color: #b42318; }
  tr.active { background: #eef6ff; }

  .select { appearance: none; border: 1px solid #d0d7de; background: #fff; color: #111; padding: 6px 10px; border-radius: 6px; font-size: 12px; }
</style>
</head>
<body>
<div class="header">
  <h1>${title}</h1>
  <div class="spacer"></div>
  <label style="font-size:12px">Period:</label>
  <select id="volPeriod" class="select">
    <option value="24h">24h</option>
    <option value="7d">7d</option>
    <option value="30d">30d</option>
  </select>
  <button id="refreshBtn" class="btn">Refresh</button>
  <div class="note" id="note">${note}</div>
</div>
<div class="container">
  <aside class="sidebar">
    <div style="display:flex; align-items:center; justify-content:space-between; gap:8px;">
      <h2 style="margin:4px">Returns (CT)</h2>
      <button id="resetSelBtn" class="btn btn-sm" title="Clear highlights">Reset</button>
    </div>
    <table>
      <thead><tr><th>Ticker</th><th>Return</th></tr></thead>
      <tbody id="retTbody"></tbody>
    </table>
  </aside>
  <div id="chart">
    <div id="yHandle" class="y-handle" title="Drag to zoom Y (double-click to reset)"></div>
  </div>
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
    xaxis: { gridcolor: '#e5e7eb', showgrid: true, showline: true, linecolor: '#e5e7eb', zeroline: false, type: 'date', title: 'Time (UTC-5)', tickmode: 'array', tickvals: ${JSON.stringify(xTickVals)}, ticktext: ${JSON.stringify(xTickText)}, range: ${JSON.stringify(xAxisRange)} },
    yaxis: { gridcolor: '#e5e7eb', zeroline: false, title: 'Return since first bar', tickformat: '+.1%' },
    legend: { orientation: 'h', y: -0.12 },
    margin: { t: 16, r: 120, b: 72, l: 64 },  // extra right margin to make room for annotation labels
    annotations: annotations
  };
  Plotly.newPlot('chart', traces, layout, {responsive: true});
  // Y-axis drag-to-zoom: click-drag vertically on left handle to set new y-range
  (function initYDrag() {
    const handle = document.getElementById('yHandle');
    if (!handle) return;
    let startY = null;
    let startRange = null;
    function screenToY(val) {
      const gd = document.getElementById('chart');
      const bbox = gd.getBoundingClientRect();
      const rel = (val - bbox.top) / bbox.height; // 0..1 top->bottom
      const y0 = layout.yaxis.range ? layout.yaxis.range[0] : gd.layout.yaxis.range[0];
      const y1 = layout.yaxis.range ? layout.yaxis.range[1] : gd.layout.yaxis.range[1];
      // invert since screen increases downwards
      return y1 - rel * (y1 - y0);
    }
    function onDown(e){
      e.preventDefault();
      const gd = document.getElementById('chart');
      const yr = (gd.layout && gd.layout.yaxis && gd.layout.yaxis.range) ? gd.layout.yaxis.range.slice() : layout.yaxis.range || [0,1];
      startY = e.clientY;
      startRange = yr;
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp, { once: true });
    }
    function onMove(e){
      if (startY == null) return;
      const gd = document.getElementById('chart');
      const dy = e.clientY - startY;
      const scale = 0.004; // sensitivity
      const span = startRange[1] - startRange[0];
      const delta = dy * span * scale;
      const newRange = [startRange[0] + delta, startRange[1] - delta];
      Plotly.relayout('chart', { 'yaxis.range': newRange });
    }
    function onUp(){ startY = null; startRange = null; window.removeEventListener('mousemove', onMove); }
    function onDbl(){
      const gd = document.getElementById('chart');
      const ydata = (gd.data || []).flatMap(tr => tr.y || []);
      if (!ydata.length) return;
      const min = Math.min(...ydata);
      const max = Math.max(...ydata);
      const pad = (max - min) * 0.05;
      Plotly.relayout('chart', { 'yaxis.range': [min - pad, max + pad] });
    }
    handle.addEventListener('mousedown', onDown);
    handle.addEventListener('dblclick', onDbl);
  })();

  async function binanceGet(path, params) {
    const qs = params ? ('?' + new URLSearchParams(params)) : '';
    let lastErr = null;
    for (const base of CONFIG.BINANCE_BASES) {
      try {
        const data = await fetchJson(base + path + qs, { headers: { 'Accept': 'application/json' } }, 3, 350);
        return data;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('All Binance bases failed');
  }

  async function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
  async function fetchJson(url, opts, retries, backoff) {
    for (let i=0; i<=retries; i++) {
      try {
        const res = await fetch(url, opts);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.json();
      } catch (e) {
        if (i === retries) throw e;
        await sleep(backoff * Math.pow(2, i));
      }
    }
  }

  function createLimiter(max){
    let running = 0; const queue = [];
    const run = () => {
      if (running >= max) return;
      const next = queue.shift();
      if (!next) return;
      running++;
      next.fn().then(next.resolve, next.reject).finally(() => { running--; run(); });
    };
    return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); run(); });
  }

  function getCache(key, ttlMs){
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || typeof obj.ts !== 'number') return null;
      if (Date.now() - obj.ts > ttlMs) return null;
      return obj.value;
    } catch { return null; }
  }
  function setCache(key, value){
    try { localStorage.setItem(key, JSON.stringify({ ts: Date.now(), value })); } catch {}
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

  async function sumDailyQuoteVolume(symbol, days) {
    const key = 'sumDaily:' + symbol + ':' + days;
    const cached = getCache(key, 10*60*1000);
    if (cached != null) return cached;
    const data = await binanceGet('/api/v3/klines', { symbol, interval: '1d', limit: days });
    let sum = 0;
    for (const k of data) { const qv = parseFloat(k[7] || '0'); if (Number.isFinite(qv)) sum += qv; }
    setCache(key, sum);
    return sum;
  }

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
    let syms = symbols.slice(0, CONFIG.TOP_N).map(r => r[0]);
    const periodSel = document.getElementById('volPeriod');
    const period = (periodSel?.value || '24h');
    if (period !== '24h') {
      const days = period === '7d' ? 7 : 30;
      const subset = symbols.slice(0, Math.max(200, CONFIG.TOP_N));
      const limitRun = createLimiter(8);
      const promises = subset.map(pair => limitRun(async () => {
        const sym = pair[0];
        try { const sum = await sumDailyQuoteVolume(sym, days); return [sym, sum]; }
        catch { return null; }
      }));
      const results = await Promise.all(promises);
      const scored = results.filter(Boolean);
      scored.sort((a,b) => b[1]-a[1]);
      syms = scored.slice(0, CONFIG.TOP_N).map(r => r[0]);
    }

    const traces = [];
    const endVals = [];
    let xTimesRef = null;
    const limitRun2 = createLimiter(8);
    function getKlinesCached(symbol, interval, limit){
      const key = 'klines:' + symbol + ':' + interval + ':' + limit;
      const cached = getCache(key, 60*1000);
      if (cached) return Promise.resolve(cached);
      return binanceGet('/api/v3/klines', { symbol, interval, limit }).then(data => { setCache(key, data); return data; });
    }
    const klTasks = syms.map(symbol => limitRun2(async () => {
      const label = CONFIG.LABEL_BASE_ONLY ? symbol.replace(/USDT$/,'') : symbol;
      try {
        const kl = await getKlinesCached(symbol, CONFIG.INTERVAL, limit);
        const rows = kl.map(r => ({ t: new Date(r[0]), c: parseFloat(r[4]) })).filter(x => Number.isFinite(x.c));
        const pct = toPercentSeries(rows);
        if (!pct.length) return null;
        const xTimes = pct.map(p => p.t);
        const y = pct.map(p => p.y);
        return { symbol, label, xTimes, y };
      } catch { return null; }
    }));
    const klResults = await Promise.all(klTasks);
    for (const res of klResults) {
      if (!res) continue;
      traces.push({ type: 'scatter', mode: 'lines', name: res.label, x: res.xTimes, y: res.y, line: { width: 1.3 } });
      endVals.push({ label: res.label, lastX: res.xTimes[res.xTimes.length-1], lastY: res.y[res.y.length-1] });
      if (!xTimesRef) xTimesRef = res.xTimes;
    }
    endVals.sort((a,b) => b.lastY - a.lastY);
    const topK = 5, botK = 5;
    const selected = endVals.slice(0, topK).concat(endVals.slice(-botK));
    const annotations = selected.map(s => ({ x: s.lastX, y: s.lastY, xref: 'x', yref: 'y', text: s.label + '  ' + (s.lastY*100).toFixed(1) + '%', showarrow: true, arrowhead: 0, arrowcolor: '#999', ax: 60, ay: 0, align: 'left', font: { size: 11, color: '#111' }, bgcolor: '#fff', bordercolor: '#e5e7eb', borderwidth: 1 }));

    const updatedAt = new Date();
    const tzFmt = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false, timeZone: CONFIG.TZ });
    const note = 'Extremes labeled (Top-5 & Bottom-5) with right-gutter arrows; last updated: ' + tzFmt.format(updatedAt) + ' (' + CONFIG.TZ + ').';
    function isTopOfHourUTCminus5(date) {
      const d = new Date(date);
      const utcMs = d.getTime();
      const offsetMs = 5 * 60 * 60 * 1000;
      const shifted = new Date(utcMs - offsetMs);
      return shifted.getUTCMinutes() === 0;
    }
    function formatHHmmUTCminus5(date) {
      const d = new Date(date);
      const utcMs = d.getTime();
      const offsetMs = 5 * 60 * 60 * 1000;
      const shifted = new Date(utcMs - offsetMs);
      let h = shifted.getUTCHours();
      const ampm = h >= 12 ? 'pm' : 'am';
      h = h % 12; if (h === 0) h = 12;
      return h + ampm;
    }
    const xTickVals = (xTimesRef || []).filter(isTopOfHourUTCminus5).map(d => new Date(d).toISOString());
    const xTickText = (xTimesRef || []).filter(isTopOfHourUTCminus5).map(formatHHmmUTCminus5);
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
      html += '<tr data-label="' + r.label + '"><td>' + r.label + '</td><td class="' + cls + '">' + pct + '</td></tr>';
    }
    tb.innerHTML = html;
  }
  renderTable(initialReturns);

  let selectedLabels = new Set();
  function applyHighlight() {
    const gd = document.getElementById('chart');
    const data = gd.data || [];
    const hasSel = selectedLabels.size > 0;
    const widths = data.map(tr => (hasSel && selectedLabels.has(tr.name)) ? 3 : 1.2);
    const opacities = data.map(tr => (hasSel && !selectedLabels.has(tr.name)) ? 0.35 : 1);
    Plotly.restyle('chart', { 'line.width': widths, 'opacity': opacities });
    // Update table row state
    const tb = document.getElementById('retTbody');
    for (const tr of tb.querySelectorAll('tr[data-label]')) {
      const lbl = tr.getAttribute('data-label');
      tr.classList.toggle('active', selectedLabels.has(lbl));
    }
  }
  document.getElementById('retTbody').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-label]');
    if (!tr) return;
    const label = tr.getAttribute('data-label');
    if (selectedLabels.has(label)) selectedLabels.delete(label); else selectedLabels.add(label);
    applyHighlight();
  });
  document.getElementById('resetSelBtn')?.addEventListener('click', () => {
    selectedLabels.clear();
    applyHighlight();
  });

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
      // removed per-symbol artificial delay for faster builds
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
  // Build hourly ticks in fixed UTC-5 regardless of viewer locale
  function isTopOfHourInUTCminus5(d) {
    const dt = dayjs(d).utcOffset(-5 * 60);
    return dt.minute() === 0;
  }
  function formatUTCminus5(d) {
    return dayjs(d).utcOffset(-5 * 60).format("HH:mm");
  }
  const xTimesRef = traces.length ? traces[0].x : [];
  const xTickVals = xTimesRef.filter(isTopOfHourInUTCminus5).map(d => new Date(d).toISOString());
  const xTickText = xTimesRef.filter(isTopOfHourInUTCminus5).map(formatUTCminus5);
  const rangeStart = xTimesRef.length ? dayjs(xTimesRef[0]).utcOffset(-5*60).startOf('hour').utc().toISOString() : null;
  const rangeEnd = xTimesRef.length ? dayjs(xTimesRef[xTimesRef.length-1]).utcOffset(-5*60).add(1,'hour').startOf('hour').utc().toISOString() : null;
  const retRows = endVals
    .slice()
    .sort((a,b) => b.lastY - a.lastY)
    .map(s => ({ label: s.label, pct: s.lastY }));
  const html = renderHTML(traces, annotations, title, note, xTickVals, xTickText, retRows, [rangeStart, rangeEnd]);
  const htmlPath = path.join(OUTDIR, "spaghetti.html");
  await fs.writeFile(htmlPath, html, "utf8");
  console.log("Saved HTML:", htmlPath);
}

main().catch(err => { console.error(err); process.exit(1); });
