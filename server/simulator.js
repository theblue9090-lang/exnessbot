'use strict';

const { EventEmitter } = require('events');

/**
 * Simulator pasar XAU/USD + paper broker untuk mode Demo.
 *
 * - Menghasilkan tick bid/ask realistis (random-walk dengan regime trending/ranging
 *   dan volatilitas ala emas).
 * - Membangun candle M1 dari tick; timeframe lain diagregasi dari M1.
 * - Paper broker: eksekusi market order di harga bid/ask, SL/TP, floating P/L,
 *   equity, margin sederhana.
 *
 * Interface broker (dipakai juga oleh adapter Exness/MetaApi):
 *   getQuote(), getCandles(tf, n), getAccountInfo(), getPositions(), getHistory(),
 *   marketOrder(side, volume, sl, tp, comment), modifyPosition(id, sl, tp),
 *   closePosition(id)
 */

const CONTRACT_SIZE = 100; // XAUUSD: 1 lot = 100 oz -> $1 pergerakan = $100/lot
const TICK_MS = 250;
const TF_MINUTES = { M1: 1, M5: 5, M15: 15, M30: 30, H1: 60 };

class MarketSimulator extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.symbol = 'XAUUSD';
    this.price = opts.startPrice || 2350 + Math.random() * 40;
    this.spread = 0.22; // spread khas gold Exness (dalam USD)
    this.trend = 0;
    this.regimeLeft = 0;
    this.vol = 0.05; // volatilitas per tick
    this.m1 = []; // candle M1: {time, open, high, low, close, volume}
    this.positions = [];
    this.history = [];
    this.nextTicket = 100000;
    this.balance = opts.balance || 10000;
    this.running = false;
    this._seedHistory(opts.seedCandles || 700);
  }

  /** Bangun riwayat M1 sintetis supaya chart & indikator langsung siap. */
  _seedHistory(n) {
    const now = Date.now();
    let t = now - n * 60000;
    t = t - (t % 60000);
    let p = this.price - 8 + Math.random() * 4;
    for (let i = 0; i < n; i++) {
      this._rotateRegime();
      const open = p;
      let high = p;
      let low = p;
      // 60 "tick" per candle seed
      for (let j = 0; j < 60; j++) {
        p += this.trend * 0.004 + (Math.random() - 0.5) * 2 * this.vol;
        if (p > high) high = p;
        if (p < low) low = p;
      }
      this.m1.push({
        time: t,
        open: round2(open),
        high: round2(high),
        low: round2(low),
        close: round2(p),
        volume: 40 + Math.floor(Math.random() * 120)
      });
      t += 60000;
    }
    this.price = p;
  }

  _rotateRegime() {
    if (this.regimeLeft-- <= 0) {
      // regime baru: trending naik/turun atau ranging
      const r = Math.random();
      if (r < 0.35) this.trend = 1 + Math.random() * 1.5;
      else if (r < 0.7) this.trend = -(1 + Math.random() * 1.5);
      else this.trend = 0;
      this.vol = 0.03 + Math.random() * 0.06;
      this.regimeLeft = 40 + Math.floor(Math.random() * 160);
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._timer = setInterval(() => this._tick(), TICK_MS);
  }

  stop() {
    this.running = false;
    clearInterval(this._timer);
  }

  _tick() {
    this._rotateRegime();
    // random walk + komponen trend, sesekali lonjakan (news spike)
    let dp = this.trend * 0.004 + (Math.random() - 0.5) * 2 * this.vol;
    if (Math.random() < 0.002) dp += (Math.random() - 0.5) * 3.5;
    this.price = Math.max(500, this.price + dp);
    this.spread = round2(0.16 + Math.random() * 0.18);

    const now = Date.now();
    const bid = round2(this.price);
    const ask = round2(this.price + this.spread);

    // update / buat candle M1 berjalan
    const bucket = now - (now % 60000);
    let last = this.m1[this.m1.length - 1];
    if (!last || last.time !== bucket) {
      last = { time: bucket, open: bid, high: bid, low: bid, close: bid, volume: 0 };
      this.m1.push(last);
      if (this.m1.length > 3000) this.m1.shift();
      this.emit('candleClosed', this.m1[this.m1.length - 2]);
    }
    last.high = Math.max(last.high, bid);
    last.low = Math.min(last.low, bid);
    last.close = bid;
    last.volume++;

    this._checkStops(bid, ask);
    this.emit('tick', { symbol: this.symbol, bid, ask, spread: this.spread, time: now });
  }

  // ---------- interface broker ----------

  getQuote() {
    const bid = round2(this.price);
    return { symbol: this.symbol, bid, ask: round2(bid + this.spread), spread: this.spread, time: Date.now() };
  }

  getCandles(tf = 'M1', n = 300) {
    const mins = TF_MINUTES[tf] || 1;
    if (mins === 1) return this.m1.slice(-n);
    const ms = mins * 60000;
    const out = [];
    for (const c of this.m1) {
      const bucket = c.time - (c.time % ms);
      const last = out[out.length - 1];
      if (!last || last.time !== bucket) {
        out.push({ time: bucket, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
      } else {
        last.high = Math.max(last.high, c.high);
        last.low = Math.min(last.low, c.low);
        last.close = c.close;
        last.volume += c.volume;
      }
    }
    return out.slice(-n);
  }

  getAccountInfo() {
    const q = this.getQuote();
    let floating = 0;
    let margin = 0;
    for (const p of this.positions) {
      floating += positionProfit(p, q);
      margin += (p.openPrice * p.volume * CONTRACT_SIZE) / 200; // leverage 1:200
    }
    const equity = this.balance + floating;
    return {
      broker: 'Demo Simulator',
      login: 'DEMO',
      currency: 'USD',
      leverage: 200,
      balance: round2(this.balance),
      equity: round2(equity),
      margin: round2(margin),
      freeMargin: round2(equity - margin),
      profit: round2(floating)
    };
  }

  getPositions() {
    const q = this.getQuote();
    return this.positions.map(p => ({ ...p, currentPrice: p.side === 'buy' ? q.bid : q.ask, profit: round2(positionProfit(p, q)) }));
  }

  getHistory() {
    return this.history.slice(-200);
  }

  async marketOrder(side, volume, sl, tp, comment = '') {
    const q = this.getQuote();
    const openPrice = side === 'buy' ? q.ask : q.bid;
    const pos = {
      id: String(this.nextTicket++),
      symbol: this.symbol,
      side,
      volume: round2(volume),
      openPrice,
      openTime: Date.now(),
      sl: sl ? round2(sl) : null,
      tp: tp ? round2(tp) : null,
      comment
    };
    this.positions.push(pos);
    this.emit('trade', { event: 'open', position: pos });
    return pos;
  }

  async modifyPosition(id, sl, tp) {
    const p = this.positions.find(x => x.id === id);
    if (!p) throw new Error('Posisi tidak ditemukan: ' + id);
    if (sl !== undefined) p.sl = sl ? round2(sl) : null;
    if (tp !== undefined) p.tp = tp ? round2(tp) : null;
    return p;
  }

  async closePosition(id, reason = 'manual') {
    const idx = this.positions.findIndex(x => x.id === id);
    if (idx === -1) throw new Error('Posisi tidak ditemukan: ' + id);
    const q = this.getQuote();
    const p = this.positions[idx];
    const closePrice = p.side === 'buy' ? q.bid : q.ask;
    const profit = round2(positionProfit(p, q));
    this.balance = round2(this.balance + profit);
    this.positions.splice(idx, 1);
    const rec = { ...p, closePrice, closeTime: Date.now(), profit, reason };
    this.history.push(rec);
    this.emit('trade', { event: 'close', position: rec });
    return rec;
  }

  _checkStops(bid, ask) {
    for (const p of [...this.positions]) {
      const price = p.side === 'buy' ? bid : ask;
      if (p.side === 'buy') {
        if (p.sl && price <= p.sl) this.closePosition(p.id, 'sl');
        else if (p.tp && price >= p.tp) this.closePosition(p.id, 'tp');
      } else {
        if (p.sl && price >= p.sl) this.closePosition(p.id, 'sl');
        else if (p.tp && price <= p.tp) this.closePosition(p.id, 'tp');
      }
    }
  }
}

function positionProfit(p, quote) {
  const cur = p.side === 'buy' ? quote.bid : quote.ask;
  const diff = p.side === 'buy' ? cur - p.openPrice : p.openPrice - cur;
  return diff * p.volume * CONTRACT_SIZE;
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

module.exports = { MarketSimulator, CONTRACT_SIZE, TF_MINUTES };
