'use strict';

const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');

const { MarketSimulator } = require('./simulator');
const { ExnessBroker } = require('./exness');
const { GoldScalperBot, DEFAULT_CONFIG } = require('./bot');

loadDotEnv();
const PORT = process.env.PORT || 3000;

/** Loader .env sederhana (tanpa dependency): KEY=VALUE per baris, # untuk komentar. */
function loadDotEnv() {
  try {
    const fs = require('fs');
    const file = path.join(__dirname, '..', '.env');
    if (!fs.existsSync(file)) return;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch (e) { /* .env opsional */ }
}

const app = express();
app.use(express.json());

// ---------- proteksi password (wajib saat di-hosting publik) ----------
// Set APP_PASSWORD di environment/.env: seluruh web, API, dan WebSocket
// hanya bisa diakses setelah memasukkan password tersebut.

const crypto = require('crypto');
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const AUTH_COOKIE = 'wt5auth';
const authSecret = crypto.randomBytes(16).toString('hex');
const authTokenValue = APP_PASSWORD
  ? crypto.createHmac('sha256', authSecret).update(APP_PASSWORD).digest('hex')
  : null;

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isAuthed(req) {
  if (!APP_PASSWORD) return true;
  const val = parseCookies(req.headers.cookie)[AUTH_COOKIE] || '';
  const a = Buffer.from(val);
  const b = Buffer.from(authTokenValue);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// health check untuk hosting (Render/Railway/dll.) — harus bebas password,
// karena platform memanggilnya tanpa login; 401 di sini membuat deploy gagal
app.get('/healthz', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.post('/auth', (req, res) => {
  const given = String((req.body || {}).password || '');
  const a = crypto.createHmac('sha256', authSecret).update(given).digest();
  const b = crypto.createHmac('sha256', authSecret).update(APP_PASSWORD).digest();
  if (!APP_PASSWORD || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ ok: false, error: 'Password salah' });
  }
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    `${AUTH_COOKIE}=${authTokenValue}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}${secure}`);
  res.json({ ok: true });
});

const LOCK_PAGE = `<!DOCTYPE html><html lang="id"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>WebTrader 5 — Login</title>
<style>body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#12161f;font:14px "Segoe UI",sans-serif;color:#d5dbe8}
.box{background:#1a1f2b;border:1px solid #2c3444;border-radius:8px;padding:28px;width:300px;text-align:center}
.logo{background:linear-gradient(135deg,#ffb300,#ff6d00);color:#14181f;font-weight:800;padding:4px 8px;border-radius:5px}
input{width:100%;box-sizing:border-box;margin:16px 0 10px;padding:10px;border-radius:4px;border:1px solid #2c3444;background:#12161f;color:#d5dbe8}
button{width:100%;padding:10px;border:none;border-radius:4px;background:#2962ff;color:#fff;font-weight:600;cursor:pointer}
.err{color:#ff8a80;font-size:12px;min-height:16px;margin-top:8px}</style></head>
<body><form class="box" id="f"><span class="logo">WT5</span> <b>WebTrader 5</b>
<input type="password" id="p" placeholder="Password aplikasi" autofocus>
<button>Masuk</button><div class="err" id="e"></div></form>
<script>document.getElementById('f').onsubmit=async ev=>{ev.preventDefault();
const r=await fetch('/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('p').value})});
if(r.ok)location.reload();else document.getElementById('e').textContent='Password salah';};</script></body></html>`;

app.use((req, res, next) => {
  if (isAuthed(req)) return next();
  if (req.path.startsWith('/api')) return res.status(401).json({ ok: false, error: 'Butuh login: masukkan APP_PASSWORD di halaman utama.' });
  res.status(401).type('html').send(LOCK_PAGE);
});

app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// ---------- state ----------

let mode = 'demo'; // 'demo' | 'exness'
let broker = new MarketSimulator();
broker.start();

const bot = new GoldScalperBot(broker);
const journal = [];

function addJournal(entry) {
  journal.push(entry);
  if (journal.length > 500) journal.shift();
  broadcast({ type: 'log', entry });
}

bot.on('log', addJournal);
bot.on('status', s => broadcast({ type: 'bot', ...s }));

function wireBroker(b) {
  b.on('tick', quote => broadcast({ type: 'tick', quote }));
  b.on('candleClosed', () => { /* frontend menyusun ulang dari snapshot */ });
  b.on('trade', ({ event, position }) => {
    if (event === 'close') bot.recordClose(position);
    broadcast({ type: 'positions', positions: b.getPositions(), history: b.getHistory(), account: b.getAccountInfo() });
    addJournal({
      time: Date.now(),
      level: event === 'open' ? 'info' : 'trade',
      message: event === 'open'
        ? `Order dibuka #${position.id} ${String(position.side).toUpperCase()} ${position.volume} lot`
        : `Posisi ditutup #${position.id} (${position.reason}) P/L ${position.profit >= 0 ? '+' : ''}${position.profit}`
    });
  });
}
wireBroker(broker);

// snapshot berkala (account, posisi) supaya UI selalu sinkron
setInterval(() => {
  try {
    broadcast({
      type: 'snapshot',
      account: broker.getAccountInfo(),
      positions: broker.getPositions(),
      botRunning: bot.running
    });
  } catch (e) { /* broker sedang ganti */ }
}, 1000);

// ---------- websocket ----------

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data);
  }
}

wss.on('connection', (ws, req) => {
  if (!isAuthed(req)) { ws.close(4401, 'unauthorized'); return; }
  ws.send(JSON.stringify({
    type: 'init',
    mode,
    account: safe(() => broker.getAccountInfo()),
    positions: safe(() => broker.getPositions()) || [],
    history: safe(() => broker.getHistory()) || [],
    quote: safe(() => broker.getQuote()),
    bot: bot.getStatus(),
    journal: journal.slice(-100)
  }));
});

function safe(fn) { try { return fn(); } catch (e) { return null; } }

// ---------- REST API ----------

app.get('/api/state', (req, res) => {
  res.json({
    mode,
    account: safe(() => broker.getAccountInfo()),
    positions: safe(() => broker.getPositions()) || [],
    history: safe(() => broker.getHistory()) || [],
    bot: bot.getStatus()
  });
});

app.get('/api/candles', (req, res) => {
  const tf = req.query.tf || 'M1';
  const n = Math.min(parseInt(req.query.n || '300', 10), 1000);
  res.json({ tf, candles: safe(() => broker.getCandles(tf, n)) || [] });
});

/**
 * Login:
 *  { mode: "demo" }
 *  { mode: "exness", login, password, server, token }
 */
/**
 * Daftar akun MT4/MT5 yang sudah terdaftar di MetaApi — supaya bisa langsung
 * dipilih di form login tanpa memasukkan password MT5 lagi.
 */
app.get('/api/exness/accounts', async (req, res) => {
  try {
    const token = req.query.token || process.env.METAAPI_TOKEN;
    if (!token) return res.json({ ok: true, accounts: [], note: 'Token MetaApi belum diisi' });
    const accounts = await ExnessBroker.listAccounts(token);
    res.json({ ok: true, accounts });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

/** Hubungkan ke Exness live dan jadikan broker aktif. */
async function connectExnessLive(creds) {
  const ex = new ExnessBroker();
  addJournal({
    time: Date.now(), level: 'info',
    message: creds.accountId
      ? `Menghubungkan ke akun MetaApi ${creds.accountId}...`
      : `Menghubungkan ke Exness ${creds.server} #${creds.login} via MetaApi...`
  });
  await ex.connect(creds, msg => addJournal({ time: Date.now(), level: 'info', message: msg }));
  const old = broker;
  broker = ex;
  mode = 'exness';
  wireBroker(broker);
  bot.setBroker(broker);
  if (old instanceof MarketSimulator) old.stop();
  else if (old && old.disconnect) safe(() => old.disconnect());
  addJournal({ time: Date.now(), level: 'success', message: 'LIVE: login Exness berhasil. Akun siap ditradingkan.' });
}

app.post('/api/login', async (req, res) => {
  const body = req.body || {};
  try {
    if (bot.running) bot.stop('login akun baru');

    if (body.mode === 'exness') {
      await connectExnessLive({
        accountId: body.accountId,
        login: body.login,
        password: body.password,
        server: body.server,
        token: body.token || process.env.METAAPI_TOKEN
      });
    } else {
      if (!(broker instanceof MarketSimulator)) {
        const old = broker;
        broker = new MarketSimulator();
        broker.start();
        wireBroker(broker);
        bot.setBroker(broker);
        safe(() => old.disconnect());
      }
      mode = 'demo';
      addJournal({ time: Date.now(), level: 'success', message: 'Masuk mode DEMO (paper trading, saldo virtual $10.000).' });
    }
    res.json({ ok: true, mode, account: broker.getAccountInfo() });
  } catch (err) {
    addJournal({ time: Date.now(), level: 'error', message: 'Login gagal: ' + err.message });
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/order', async (req, res) => {
  try {
    const { side, volume, sl, tp } = req.body || {};
    if (!['buy', 'sell'].includes(side)) throw new Error('side harus buy/sell');
    const vol = Math.max(0.01, Number(volume) || 0.01);
    const pos = await broker.marketOrder(side, vol, sl ? Number(sl) : null, tp ? Number(tp) : null, 'manual');
    res.json({ ok: true, position: pos });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/position/close', async (req, res) => {
  try {
    const rec = await broker.closePosition(String(req.body.id), 'manual');
    res.json({ ok: true, closed: rec });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/bot/start', (req, res) => {
  try {
    if (req.body && Object.keys(req.body).length) bot.updateConfig(req.body);
    bot.start();
    res.json({ ok: true, bot: bot.getStatus() });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/bot/stop', (req, res) => {
  bot.stop();
  res.json({ ok: true, bot: bot.getStatus() });
});

app.post('/api/bot/config', (req, res) => {
  bot.updateConfig(req.body || {});
  res.json({ ok: true, bot: bot.getStatus() });
});

app.get('/api/bot/defaults', (req, res) => res.json(DEFAULT_CONFIG));

// endpoint /api yang tidak dikenal -> selalu balas JSON, bukan halaman HTML 404
app.use('/api', (req, res) => {
  res.status(404).json({ ok: false, error: 'Endpoint tidak ditemukan: ' + req.originalUrl });
});

// error handler (mis. body JSON rusak) -> balas JSON, bukan halaman HTML error
app.use((err, req, res, next) => {
  res.status(err.status || 500).json({ ok: false, error: err.message || 'Internal server error' });
});

server.listen(PORT, () => {
  console.log(`WebTrader 5 berjalan di http://localhost:${PORT}`);
  addJournal({ time: Date.now(), level: 'info', message: 'Server siap. Mode DEMO aktif — login Exness lewat tombol "Login Broker".' });
  autoConnectLive();
});

/**
 * Auto-login LIVE saat server start jika kredensial tersedia di environment
 * (atau file .env):
 *   METAAPI_TOKEN, EXNESS_LOGIN, EXNESS_PASSWORD, EXNESS_SERVER
 * Opsional: AUTO_START_BOT=1 untuk langsung menyalakan bot setelah tersambung.
 */
async function autoConnectLive() {
  const { METAAPI_TOKEN, EXNESS_LOGIN, EXNESS_PASSWORD, EXNESS_SERVER, METAAPI_ACCOUNT_ID, AUTO_START_BOT } = process.env;
  if (!METAAPI_TOKEN) return;

  try {
    let creds = null;
    if (METAAPI_ACCOUNT_ID) {
      creds = { token: METAAPI_TOKEN, accountId: METAAPI_ACCOUNT_ID };
    } else if (EXNESS_LOGIN && EXNESS_PASSWORD && EXNESS_SERVER) {
      creds = { token: METAAPI_TOKEN, login: EXNESS_LOGIN, password: EXNESS_PASSWORD, server: EXNESS_SERVER };
    } else {
      // hanya token: cari akun yang sudah terdaftar di MetaApi
      addJournal({ time: Date.now(), level: 'info', message: 'METAAPI_TOKEN terdeteksi — mencari akun yang sudah terdaftar di MetaApi...' });
      const accounts = await ExnessBroker.listAccounts(METAAPI_TOKEN);
      if (!accounts.length) {
        addJournal({
          time: Date.now(), level: 'warn',
          message: 'Belum ada akun terdaftar di MetaApi. Isi EXNESS_LOGIN/PASSWORD/SERVER di .env atau login lewat tombol "Login Broker".'
        });
        return;
      }
      if (accounts.length > 1) {
        addJournal({
          time: Date.now(), level: 'warn',
          message: `Ada ${accounts.length} akun di MetaApi: ` +
            accounts.map(a => `#${a.login}@${a.server} (id ${a.id})`).join(', ') +
            ' — pilih salah satu lewat tombol "Login Broker", atau set METAAPI_ACCOUNT_ID di .env.'
        });
        return;
      }
      creds = { token: METAAPI_TOKEN, accountId: accounts[0].id };
      addJournal({ time: Date.now(), level: 'info', message: `Akun ditemukan: #${accounts[0].login} @ ${accounts[0].server} — mencoba auto-login LIVE...` });
    }

    await connectExnessLive(creds);
    if (AUTO_START_BOT === '1' || String(AUTO_START_BOT).toLowerCase() === 'true') {
      bot.start();
      addJournal({ time: Date.now(), level: 'success', message: 'AUTO_START_BOT aktif — bot GoldScalper langsung trading LIVE.' });
    }
  } catch (err) {
    addJournal({ time: Date.now(), level: 'error', message: 'Auto-login LIVE gagal: ' + err.message + ' — server tetap berjalan dalam mode DEMO.' });
  }
}
