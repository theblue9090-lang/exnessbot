'use strict';

/* ===== WebTrader 5 — frontend =====
 * WebSocket untuk data realtime, canvas untuk chart candlestick ala MT5.
 */

const $ = id => document.getElementById(id);

/**
 * Fetch pembungkus: selalu memvalidasi respons sebelum di-parse sebagai JSON,
 * supaya error server (halaman HTML 404/500, proxy, salah alamat) menjadi
 * pesan yang jelas — bukan "Unexpected token ... is not valid JSON".
 */
async function api(url, opts) {
  let res;
  try {
    res = await fetch(url, opts);
  } catch (e) {
    throw new Error('Tidak bisa terhubung ke server (' + e.message + '). Pastikan server berjalan: npm start');
  }
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(
      'Server tidak mengembalikan JSON (HTTP ' + res.status + ' di ' + url + '). ' +
      'Pastikan website dibuka lewat server Node-nya (npm start, lalu buka http://localhost:3000) — ' +
      'bukan membuka file HTML langsung atau lewat hosting statis.'
    );
  }
  if (!res.ok || data.ok === false) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

function journalError(msg) {
  addJournalLine({ time: Date.now(), level: 'error', message: msg });
}

const state = {
  tf: 'M1',
  candles: [],
  quote: null,
  positions: [],
  history: [],
  account: null,
  bot: { running: false, config: {} },
  mode: 'demo',
  lastBid: null
};

// ---------- WebSocket ----------

let ws;
let wsWarned = false;
function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => { wsWarned = false; };
  ws.onmessage = e => handleMsg(JSON.parse(e.data));
  ws.onclose = () => {
    if (!wsWarned) {
      wsWarned = true;
      journalError('Koneksi realtime terputus — mencoba menyambung ulang... ' +
        'Jika terus gagal, pastikan server berjalan (npm start) dan halaman dibuka dari alamat server tersebut.');
    }
    setTimeout(connectWs, 1500);
  };
}

function handleMsg(msg) {
  switch (msg.type) {
    case 'init':
      state.mode = msg.mode;
      state.account = msg.account;
      state.positions = msg.positions || [];
      state.history = msg.history || [];
      state.bot = msg.bot || state.bot;
      if (msg.quote) applyQuote(msg.quote);
      (msg.journal || []).forEach(addJournalLine);
      updateModeBadge();
      updateBotUi();
      renderAccount();
      renderPositions();
      renderHistory();
      loadCandles();
      break;
    case 'tick':
      applyQuote(msg.quote);
      updateLiveCandle(msg.quote);
      break;
    case 'snapshot':
      state.account = msg.account;
      state.positions = msg.positions || [];
      if (state.bot.running !== msg.botRunning) {
        state.bot.running = msg.botRunning;
        updateBotUi();
      }
      renderAccount();
      renderPositions();
      break;
    case 'positions':
      state.positions = msg.positions || [];
      state.history = msg.history || state.history;
      state.account = msg.account || state.account;
      renderAccount();
      renderPositions();
      renderHistory();
      break;
    case 'bot':
      state.bot.running = msg.running;
      if (msg.config) state.bot.config = msg.config;
      updateBotUi();
      break;
    case 'log':
      addJournalLine(msg.entry);
      break;
  }
}

// ---------- Quote / Market watch ----------

function applyQuote(q) {
  if (!q || !q.bid) return;
  const dir = state.lastBid === null ? 0 : Math.sign(q.bid - state.lastBid);
  state.lastBid = q.bid;
  state.quote = q;

  $('mwSymbol').textContent = q.symbol || 'XAUUSD';
  const bidEl = $('mwBid');
  const askEl = $('mwAsk');
  bidEl.textContent = q.bid.toFixed(2);
  askEl.textContent = q.ask.toFixed(2);
  bidEl.className = 'num ' + (dir > 0 ? 'flash-up' : dir < 0 ? 'flash-down' : '');
  askEl.className = bidEl.className;
  $('mwSpread').textContent = (q.spread ?? (q.ask - q.bid)).toFixed(2);
  $('sellPx').textContent = q.bid.toFixed(2);
  $('buyPx').textContent = q.ask.toFixed(2);
}

// ---------- Candles / chart ----------

let lastCandleErr = null;
async function loadCandles() {
  try {
    const data = await api(`/api/candles?tf=${state.tf}&n=400`);
    state.candles = data.candles || [];
    lastCandleErr = null;
    drawChart();
  } catch (err) {
    // jangan spam journal saat polling — hanya catat pesan error yang baru
    if (err.message !== lastCandleErr) {
      lastCandleErr = err.message;
      journalError('Gagal memuat candle: ' + err.message);
    }
  }
}

function tfMs() {
  return { M1: 1, M5: 5, M15: 15, H1: 60 }[state.tf] * 60000;
}

function updateLiveCandle(q) {
  if (!state.candles.length || !q || !q.bid) return;
  const ms = tfMs();
  const bucket = q.time - (q.time % ms);
  let last = state.candles[state.candles.length - 1];
  if (last.time === bucket) {
    last.close = q.bid;
    last.high = Math.max(last.high, q.bid);
    last.low = Math.min(last.low, q.bid);
  } else if (bucket > last.time) {
    state.candles.push({ time: bucket, open: q.bid, high: q.bid, low: q.bid, close: q.bid, volume: 0 });
    if (state.candles.length > 500) state.candles.shift();
  }
  drawChart();
}

// EMA untuk overlay chart
function emaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i];
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

const canvas = $('chart');
const ctx = canvas.getContext('2d');
let mouse = null;

function drawChart() {
  const wrap = canvas.parentElement;
  const W = wrap.clientWidth;
  const H = wrap.clientHeight;
  if (canvas.width !== W * devicePixelRatio) {
    canvas.width = W * devicePixelRatio;
    canvas.height = H * devicePixelRatio;
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  }
  ctx.clearRect(0, 0, W, H);

  const candles = state.candles.slice(-160);
  if (!candles.length) return;

  const padR = 64, padB = 22, padT = 10;
  const plotW = W - padR, plotH = H - padB - padT;

  let min = Infinity, max = -Infinity;
  for (const c of candles) { min = Math.min(min, c.low); max = Math.max(max, c.high); }
  // sertakan garis SL/TP posisi dalam skala
  for (const p of state.positions) {
    if (p.sl) { min = Math.min(min, p.sl); max = Math.max(max, p.sl); }
    if (p.tp) { min = Math.min(min, p.tp); max = Math.max(max, p.tp); }
  }
  const range = (max - min) || 1;
  min -= range * 0.06; max += range * 0.06;

  const y = v => padT + (max - v) / (max - min) * plotH;
  const step = plotW / candles.length;
  const bw = Math.max(1, Math.min(9, step * 0.65));

  // grid
  ctx.strokeStyle = '#1c2230';
  ctx.lineWidth = 1;
  ctx.font = '10px Segoe UI, sans-serif';
  ctx.fillStyle = '#7c8697';
  const gridLines = 6;
  for (let i = 0; i <= gridLines; i++) {
    const v = max - (max - min) * i / gridLines;
    const yy = y(v);
    ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(plotW, yy); ctx.stroke();
    ctx.fillText(v.toFixed(2), plotW + 6, yy + 3);
  }
  // label waktu
  for (let i = 0; i < candles.length; i += Math.ceil(candles.length / 6)) {
    const d = new Date(candles[i].time);
    const label = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    ctx.fillText(label, i * step, H - 8);
  }

  // candle
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const x = i * step + step / 2;
    const up = c.close >= c.open;
    ctx.strokeStyle = up ? '#26a69a' : '#ef5350';
    ctx.fillStyle = up ? '#26a69a' : '#ef5350';
    ctx.beginPath();
    ctx.moveTo(x, y(c.high));
    ctx.lineTo(x, y(c.low));
    ctx.stroke();
    const yo = y(c.open), yc = y(c.close);
    const top = Math.min(yo, yc);
    const h = Math.max(1, Math.abs(yc - yo));
    ctx.fillRect(x - bw / 2, top, bw, h);
  }

  // overlay EMA 9/21/50
  const closes = candles.map(c => c.close);
  const overlays = [
    { s: emaSeries(closes, 9), color: '#ffd54f' },
    { s: emaSeries(closes, 21), color: '#4fc3f7' },
    { s: emaSeries(closes, 50), color: '#ba68c8' }
  ];
  for (const o of overlays) {
    ctx.strokeStyle = o.color;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < o.s.length; i++) {
      if (o.s[i] === null) continue;
      const x = i * step + step / 2;
      if (!started) { ctx.moveTo(x, y(o.s[i])); started = true; }
      else ctx.lineTo(x, y(o.s[i]));
    }
    ctx.stroke();
  }

  // garis bid
  if (state.quote) {
    const yy = y(state.quote.bid);
    ctx.strokeStyle = '#ffb300';
    ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(plotW, yy); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#ffb300';
    ctx.fillRect(plotW, yy - 8, padR, 16);
    ctx.fillStyle = '#1a1400';
    ctx.fillText(state.quote.bid.toFixed(2), plotW + 6, yy + 3);
  }

  // garis posisi (entry/SL/TP)
  for (const p of state.positions) {
    drawHLine(y(p.openPrice), p.side === 'buy' ? '#2962ff' : '#ef5350', `#${p.id} ${p.side.toUpperCase()}`);
    if (p.sl) drawHLine(y(p.sl), '#ef5350', 'SL', true);
    if (p.tp) drawHLine(y(p.tp), '#26a69a', 'TP', true);
  }
  function drawHLine(yy, color, label, dashed) {
    ctx.strokeStyle = color;
    if (dashed) ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(plotW, yy); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.fillText(label, 4, yy - 3);
  }

  // crosshair
  if (mouse) {
    ctx.strokeStyle = 'rgba(255,255,255,.25)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(mouse.x, 0); ctx.lineTo(mouse.x, H - padB); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, mouse.y); ctx.lineTo(plotW, mouse.y); ctx.stroke();
    ctx.setLineDash([]);
    const v = max - (mouse.y - padT) / plotH * (max - min);
    ctx.fillStyle = '#2c3444';
    ctx.fillRect(plotW, mouse.y - 8, padR, 16);
    ctx.fillStyle = '#d5dbe8';
    ctx.fillText(v.toFixed(2), plotW + 6, mouse.y + 3);
  }

  // OHLC header
  const lc = candles[candles.length - 1];
  $('chartOHLC').textContent = `O ${lc.open.toFixed(2)}  H ${lc.high.toFixed(2)}  L ${lc.low.toFixed(2)}  C ${lc.close.toFixed(2)}`;
}

canvas.addEventListener('mousemove', e => {
  const r = canvas.getBoundingClientRect();
  mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
  drawChart();
});
canvas.addEventListener('mouseleave', () => { mouse = null; drawChart(); });
window.addEventListener('resize', drawChart);

// ---------- Tabel akun / posisi / riwayat ----------

function fmt(x, d = 2) { return x === null || x === undefined ? '—' : Number(x).toFixed(d); }
function fmtTime(t) {
  const d = new Date(t);
  return d.toLocaleString('id-ID', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function renderAccount() {
  const a = state.account;
  if (!a) return;
  $('accBalance').textContent = fmt(a.balance);
  $('accEquity').textContent = fmt(a.equity);
  $('accMargin').textContent = fmt(a.margin);
  $('accFree').textContent = fmt(a.freeMargin);
  const p = $('accProfit');
  p.textContent = (a.profit >= 0 ? '+' : '') + fmt(a.profit);
  p.className = a.profit >= 0 ? 'pos' : 'neg';
  $('navAccount').textContent = `💼 ${a.broker || ''} ${a.login || ''} (${a.currency || 'USD'})`;
}

function renderPositions() {
  const tb = $('posBody');
  if (!state.positions.length) {
    tb.innerHTML = '<tr><td colspan="10" class="empty">Tidak ada posisi terbuka</td></tr>';
    return;
  }
  tb.innerHTML = state.positions.map(p => `
    <tr>
      <td>${p.id}</td>
      <td>${fmtTime(p.openTime)}</td>
      <td class="type-${p.side}">${p.side.toUpperCase()}${(p.comment || '').includes('GoldScalper') ? ' 🤖' : ''}</td>
      <td>${fmt(p.volume)}</td>
      <td>${fmt(p.openPrice)}</td>
      <td>${fmt(p.sl)}</td>
      <td>${fmt(p.tp)}</td>
      <td>${fmt(p.currentPrice)}</td>
      <td class="${p.profit >= 0 ? 'pl-pos' : 'pl-neg'}">${p.profit >= 0 ? '+' : ''}${fmt(p.profit)}</td>
      <td><button class="btn-x" onclick="closePos('${p.id}')">✕</button></td>
    </tr>`).join('');
}

function renderHistory() {
  const tb = $('histBody');
  if (!state.history.length) {
    tb.innerHTML = '<tr><td colspan="8" class="empty">Belum ada riwayat</td></tr>';
    return;
  }
  tb.innerHTML = [...state.history].reverse().map(h => `
    <tr>
      <td>${h.id}</td>
      <td>${fmtTime(h.closeTime)}</td>
      <td class="type-${h.side}">${h.side.toUpperCase()}${(h.comment || '').includes('GoldScalper') ? ' 🤖' : ''}</td>
      <td>${fmt(h.volume)}</td>
      <td>${fmt(h.openPrice)}</td>
      <td>${fmt(h.closePrice)}</td>
      <td>${h.reason || ''}</td>
      <td class="${h.profit >= 0 ? 'pl-pos' : 'pl-neg'}">${h.profit >= 0 ? '+' : ''}${fmt(h.profit)}</td>
    </tr>`).join('');
}

window.closePos = async function (id) {
  try {
    await api('/api/position/close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
  } catch (err) {
    journalError('Gagal menutup posisi #' + id + ': ' + err.message);
  }
};

// ---------- Journal ----------

function addJournalLine(entry) {
  if (!entry) return;
  const el = document.createElement('div');
  el.className = `jl jl-${entry.level || 'info'}`;
  const t = new Date(entry.time).toLocaleTimeString('id-ID');
  el.innerHTML = `<span class="t">${t}</span>${escapeHtml(entry.message)}`;
  const j = $('journal');
  j.appendChild(el);
  while (j.children.length > 400) j.removeChild(j.firstChild);
  j.scrollTop = j.scrollHeight;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---------- Order manual ----------

$('btnBuy').onclick = () => sendOrder('buy');
$('btnSell').onclick = () => sendOrder('sell');

async function sendOrder(side) {
  const volume = parseFloat($('volInput').value) || 0.01;
  try {
    await api('/api/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ side, volume })
    });
  } catch (err) {
    journalError('Order gagal: ' + err.message);
  }
}

// ---------- Timeframe & tab ----------

$('tfGroup').addEventListener('click', e => {
  const btn = e.target.closest('.tf');
  if (!btn) return;
  document.querySelectorAll('.tf').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  state.tf = btn.dataset.tf;
  $('chartTitle').textContent = `${state.quote ? state.quote.symbol : 'XAUUSD'}, ${state.tf}`;
  loadCandles();
});

document.querySelectorAll('.ttab').forEach(t => {
  t.onclick = () => {
    document.querySelectorAll('.ttab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    ['trade', 'history', 'journal'].forEach(name =>
      $('tab-' + name).classList.toggle('hidden', name !== t.dataset.tab));
  };
});

// ---------- Bot ----------

function updateBotUi() {
  const running = state.bot.running;
  $('botDot').className = 'bot-dot' + (running ? ' on' : '');
  $('botLabel').textContent = running ? 'Bot: ON' : 'Bot: OFF';
  const b = $('btnBot');
  b.textContent = running ? '■ Stop Bot' : '▶ Start Bot';
  b.className = 'btn-bot' + (running ? ' running' : '');
  const nav = $('navBotState');
  nav.textContent = running ? 'on' : 'off';
  nav.className = running ? 'ea-on' : 'ea-off';
}

$('btnBot').onclick = async () => {
  const url = state.bot.running ? '/api/bot/stop' : '/api/bot/start';
  try {
    const data = await api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    state.bot = data.bot;
    updateBotUi();
  } catch (err) {
    journalError('Bot: ' + err.message);
  }
};

// modal konfigurasi bot
$('btnBotCfg').onclick = async () => {
  let cfg = state.bot.config && state.bot.config.timeframe ? state.bot.config : null;
  if (!cfg) {
    try {
      cfg = await api('/api/bot/defaults');
    } catch (err) {
      journalError('Gagal memuat konfigurasi bot: ' + err.message);
      return;
    }
  }
  $('cfgTf').value = cfg.timeframe;
  $('cfgEntryMode').value = cfg.entryMode === 'candleOpen'
    ? 'candleOpen'
    : (cfg.aggressive ? 'signal-aggressive' : 'signal-normal');
  $('cfgRisk').value = cfg.riskPercent;
  $('cfgMaxPos').value = cfg.maxPositions;
  $('cfgMinMargin').value = cfg.minFreeMarginPct;
  $('cfgMaxLot').value = cfg.maxLot;
  $('cfgSl').value = cfg.slAtr;
  $('cfgTp').value = cfg.tpAtr;
  $('cfgSpread').value = cfg.maxSpread;
  $('cfgCooldown').value = cfg.cooldownSec;
  $('cfgDD').value = cfg.maxDailyLossPct;
  $('cfgTarget').value = cfg.dailyProfitTargetPct;
  $('botModal').classList.remove('hidden');
};
$('btnCloseCfg').onclick = () => $('botModal').classList.add('hidden');
$('btnSaveCfg').onclick = async () => {
  const mode = $('cfgEntryMode').value;
  const body = {
    timeframe: $('cfgTf').value,
    entryMode: mode === 'candleOpen' ? 'candleOpen' : 'signal',
    aggressive: mode === 'signal-aggressive' || mode === 'candleOpen',
    riskPercent: $('cfgRisk').value,
    maxPositions: $('cfgMaxPos').value,
    minFreeMarginPct: $('cfgMinMargin').value,
    maxLot: $('cfgMaxLot').value,
    slAtr: $('cfgSl').value,
    tpAtr: $('cfgTp').value,
    maxSpread: $('cfgSpread').value,
    cooldownSec: $('cfgCooldown').value,
    maxDailyLossPct: $('cfgDD').value,
    dailyProfitTargetPct: $('cfgTarget').value
  };
  try {
    const data = await api('/api/bot/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    state.bot = data.bot;
  } catch (err) {
    journalError('Gagal menyimpan konfigurasi: ' + err.message);
  }
  $('botModal').classList.add('hidden');
};

// ---------- Login ----------

let loginMode = 'exness';

function updateModeBadge() {
  const b = $('connBadge');
  if (state.mode === 'exness') { b.textContent = 'EXNESS LIVE'; b.className = 'badge live'; }
  else { b.textContent = 'DEMO'; b.className = 'badge demo'; }
}

$('btnLogin').onclick = () => {
  $('loginErr').classList.add('hidden');
  $('loginModal').classList.remove('hidden');
  loadMetaApiAccounts();
};

/** Ambil akun yang sudah terdaftar di MetaApi (token dari form atau .env server). */
async function loadMetaApiAccounts() {
  const box = $('maAccounts');
  const list = $('maAccountList');
  try {
    const token = $('exToken').value.trim();
    const data = await api('/api/exness/accounts' + (token ? '?token=' + encodeURIComponent(token) : ''));
    if (!data.accounts || !data.accounts.length) { box.classList.add('hidden'); return; }
    list.innerHTML = '';
    for (const a of data.accounts) {
      const btn = document.createElement('button');
      btn.className = 'ma-acc';
      btn.innerHTML = `💼 #${escapeHtml(String(a.login || ''))} @ ${escapeHtml(a.server || '')} ` +
        `<span class="st">${escapeHtml(a.platform || '')} · ${escapeHtml(a.state || '')}</span>`;
      btn.onclick = () => doLogin({ mode: 'exness', accountId: a.id, token: token || undefined });
      list.appendChild(btn);
    }
    box.classList.remove('hidden');
  } catch (err) {
    box.classList.add('hidden');
  }
}
$('exToken').addEventListener('change', loadMetaApiAccounts);
$('btnCancelLogin').onclick = () => $('loginModal').classList.add('hidden');

document.querySelectorAll('.ltab').forEach(t => {
  t.onclick = () => {
    document.querySelectorAll('.ltab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    loginMode = t.dataset.mode;
    $('exnessForm').classList.toggle('hidden', loginMode !== 'exness');
    $('demoForm').classList.toggle('hidden', loginMode !== 'demo');
  };
});

async function doLogin(body) {
  const errEl = $('loginErr');
  errEl.classList.add('hidden');
  $('btnDoLogin').disabled = true;
  $('btnDoLogin').textContent = 'Menghubungkan...';
  try {
    const data = await api('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    state.mode = data.mode;
    updateModeBadge();
    $('loginModal').classList.add('hidden');
    loadCandles();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  } finally {
    $('btnDoLogin').disabled = false;
    $('btnDoLogin').textContent = 'Login';
  }
}

$('btnDoLogin').onclick = () => {
  const body = loginMode === 'exness'
    ? {
        mode: 'exness',
        login: $('exLogin').value.trim(),
        password: $('exPass').value,
        server: $('exServer').value.trim(),
        token: $('exToken').value.trim()
      }
    : { mode: 'demo' };
  doLogin(body);
};

// refresh candle penuh tiap 20 detik agar agregasi TF akurat
setInterval(loadCandles, 20000);

connectWs();
