'use strict';

const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');

const { MarketSimulator } = require('./simulator');
const { ExnessBroker } = require('./exness');
const { GoldScalperBot, DEFAULT_CONFIG } = require('./bot');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());
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

wss.on('connection', ws => {
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
app.post('/api/login', async (req, res) => {
  const body = req.body || {};
  try {
    if (bot.running) bot.stop('login akun baru');

    if (body.mode === 'exness') {
      const ex = new ExnessBroker();
      addJournal({ time: Date.now(), level: 'info', message: `Menghubungkan ke Exness ${body.server} #${body.login} via MetaApi...` });
      await ex.connect(
        { login: body.login, password: body.password, server: body.server, token: body.token },
        msg => addJournal({ time: Date.now(), level: 'info', message: msg })
      );
      const old = broker;
      broker = ex;
      mode = 'exness';
      wireBroker(broker);
      bot.setBroker(broker);
      if (old instanceof MarketSimulator) old.stop();
      addJournal({ time: Date.now(), level: 'success', message: 'Login Exness berhasil. Akun siap ditradingkan.' });
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

server.listen(PORT, () => {
  console.log(`WebTrader 5 berjalan di http://localhost:${PORT}`);
  addJournal({ time: Date.now(), level: 'info', message: 'Server siap. Mode DEMO aktif — login Exness lewat tombol "Login Broker".' });
});
