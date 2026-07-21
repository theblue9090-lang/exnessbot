'use strict';

const { EventEmitter } = require('events');
const { emaSeries, rsi, atr } = require('./indicators');
const { CONTRACT_SIZE } = require('./simulator');

/**
 * GoldScalper — bot scalping XAU/USD untuk timeframe M1/M5.
 *
 * Strategi (konfluensi beberapa filter, entry hanya saat candle close):
 *  - Trend  : EMA9 vs EMA21, harga relatif terhadap EMA50.
 *  - Trigger: fresh crossover EMA9/EMA21 (<=3 candle) ATAU pullback ke EMA9
 *             yang kembali ditutup searah trend.
 *  - Momentum: RSI(14) di zona 50-72 (buy) / 28-50 (sell), body candle
 *             minimal 25% ATR searah sinyal.
 *  - Volatilitas: SL = slAtr x ATR(14), TP = tpAtr x ATR(14).
 *
 * Manajemen posisi (dievaluasi tiap tick):
 *  - Break-even: SL digeser ke harga entry (+buffer) setelah profit 0.5 x ATR.
 *  - Trailing stop: mengikuti harga sejauh trailAtr x ATR setelah profit 0.8 x ATR.
 *
 * Manajemen risiko:
 *  - Lot dihitung dari riskPercent terhadap equity dan jarak SL.
 *  - Filter spread maksimum, jumlah posisi maksimum, cooldown antar entry,
 *    dan proteksi kerugian harian (bot berhenti sendiri).
 *
 * Bot langsung mengeksekusi order tanpa konfirmasi begitu di-start.
 */

const DEFAULT_CONFIG = {
  symbol: 'XAUUSD',
  timeframe: 'M1',        // M1 atau M5
  riskPercent: 1.0,       // % equity yang dirisikokan per trade
  maxLot: 2.0,
  minLot: 0.01,
  maxPositions: 2,
  maxSpread: 0.4,         // USD
  slAtr: 1.5,
  tpAtr: 1.1,
  breakEvenAtr: 0.5,
  trailStartAtr: 0.8,
  trailAtr: 0.8,
  cooldownSec: 45,        // jeda minimal antar entry
  maxDailyLossPct: 5,     // stop otomatis jika rugi harian tembus % equity awal hari
  dailyProfitTargetPct: 0 // 0 = tanpa target (bot terus jalan)
};

class GoldScalperBot extends EventEmitter {
  constructor(broker, config = {}) {
    super();
    this.broker = broker;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.running = false;
    this.lastEntryAt = 0;
    this.lastSignalCandle = 0;
    this.dayStart = null; // { date, equity }
    this.stats = { trades: 0, wins: 0, losses: 0, profit: 0 };
    this._tickHandler = () => this._onTick();
  }

  setBroker(broker) {
    const wasRunning = this.running;
    if (wasRunning) this.stop('ganti broker');
    this.broker = broker;
    if (wasRunning) this.start();
  }

  updateConfig(cfg = {}) {
    for (const k of Object.keys(cfg)) {
      if (k in DEFAULT_CONFIG) {
        const v = k === 'symbol' || k === 'timeframe' ? cfg[k] : Number(cfg[k]);
        if (v !== undefined && v !== null && !(typeof v === 'number' && isNaN(v))) this.config[k] = v;
      }
    }
    this._log('info', 'Konfigurasi diperbarui: ' + JSON.stringify(this.config));
  }

  start() {
    if (this.running) return;
    if (!this.broker) throw new Error('Belum terhubung ke broker');
    this.running = true;
    this._resetDayIfNeeded(true);
    this.broker.on('tick', this._tickHandler);
    this._log('success', `Bot GoldScalper AKTIF — ${this.config.symbol} ${this.config.timeframe}, risk ${this.config.riskPercent}%/trade. Trading otomatis berjalan tanpa konfirmasi.`);
    this.emit('status', this.getStatus());
  }

  stop(reason = 'dihentikan pengguna') {
    if (!this.running) return;
    this.running = false;
    if (this.broker) this.broker.removeListener('tick', this._tickHandler);
    this._log('warn', 'Bot berhenti: ' + reason);
    this.emit('status', this.getStatus());
  }

  getStatus() {
    return { running: this.running, config: this.config, stats: this.stats };
  }

  recordClose(rec) {
    // dipanggil server saat posisi milik bot tertutup (sl/tp/manual)
    if (!rec.comment || !String(rec.comment).includes('GoldScalper')) return;
    this.stats.trades++;
    this.stats.profit = round2(this.stats.profit + rec.profit);
    if (rec.profit >= 0) this.stats.wins++; else this.stats.losses++;
    this._log(rec.profit >= 0 ? 'success' : 'error',
      `Posisi #${rec.id} ${rec.side.toUpperCase()} ${rec.volume} lot ditutup (${rec.reason}) — P/L ${fmtUsd(rec.profit)} | total ${fmtUsd(this.stats.profit)} (${this.stats.wins}W/${this.stats.losses}L)`);
  }

  // ---------- loop utama ----------

  async _onTick() {
    if (!this.running) return;
    try {
      this._resetDayIfNeeded();
      if (!this._checkDailyGuards()) return;
      await this._managePositions();
      await this._maybeEnter();
    } catch (err) {
      this._log('error', 'Error bot: ' + err.message);
    }
  }

  _resetDayIfNeeded(force = false) {
    const today = new Date().toISOString().slice(0, 10);
    if (force || !this.dayStart || this.dayStart.date !== today) {
      const acc = this.broker.getAccountInfo();
      this.dayStart = { date: today, equity: acc.equity };
    }
  }

  _checkDailyGuards() {
    const acc = this.broker.getAccountInfo();
    const pl = acc.equity - this.dayStart.equity;
    const lossLimit = -(this.config.maxDailyLossPct / 100) * this.dayStart.equity;
    if (this.config.maxDailyLossPct > 0 && pl <= lossLimit) {
      this.stop(`proteksi harian: kerugian ${fmtUsd(pl)} menembus batas ${this.config.maxDailyLossPct}%`);
      return false;
    }
    const target = (this.config.dailyProfitTargetPct / 100) * this.dayStart.equity;
    if (this.config.dailyProfitTargetPct > 0 && pl >= target) {
      this.stop(`target profit harian tercapai: ${fmtUsd(pl)}`);
      return false;
    }
    return true;
  }

  /** Break-even + trailing stop untuk posisi milik bot. */
  async _managePositions() {
    const candles = this.broker.getCandles(this.config.timeframe, 60);
    const a = atr(candles.slice(0, -1), 14);
    if (!a) return;
    const q = this.broker.getQuote();

    for (const p of this.broker.getPositions()) {
      if (!p.comment || !String(p.comment).includes('GoldScalper')) continue;
      const dir = p.side === 'buy' ? 1 : -1;
      const cur = p.side === 'buy' ? q.bid : q.ask;
      const gain = (cur - p.openPrice) * dir;

      let newSl = null;
      // break-even
      if (gain >= this.config.breakEvenAtr * a) {
        const be = p.openPrice + dir * 0.05; // buffer 5 sen menutup biaya
        if (p.sl === null || (p.sl - be) * dir < 0) newSl = be;
      }
      // trailing
      if (gain >= this.config.trailStartAtr * a) {
        const trail = cur - dir * this.config.trailAtr * a;
        if (newSl === null || (trail - newSl) * dir > 0) {
          if (p.sl === null || (trail - p.sl) * dir > 0.01) newSl = trail;
        }
      }
      if (newSl !== null && (p.sl === null || Math.abs(newSl - p.sl) > 0.01)) {
        await this.broker.modifyPosition(p.id, round2(newSl), p.tp);
        this._log('info', `Trailing #${p.id}: SL -> ${round2(newSl)}`);
      }
    }
  }

  async _maybeEnter() {
    const cfg = this.config;
    const now = Date.now();
    if ((now - this.lastEntryAt) / 1000 < cfg.cooldownSec) return;

    const botPositions = this.broker.getPositions().filter(p => String(p.comment || '').includes('GoldScalper'));
    if (botPositions.length >= cfg.maxPositions) return;

    const q = this.broker.getQuote();
    if (q.spread > cfg.maxSpread) return;

    const candles = this.broker.getCandles(cfg.timeframe, 220);
    if (candles.length < 80) return;
    const closed = candles.slice(0, -1); // hanya candle yang sudah close
    const lastCandle = closed[closed.length - 1];
    if (this.lastSignalCandle === lastCandle.time) return; // satu evaluasi per candle

    const signal = this._computeSignal(closed);
    this.lastSignalCandle = lastCandle.time;
    if (!signal) return;

    const { side, atrVal, reason } = signal;
    const entry = side === 'buy' ? q.ask : q.bid;
    const slDist = cfg.slAtr * atrVal;
    const tpDist = cfg.tpAtr * atrVal;
    const sl = round2(side === 'buy' ? entry - slDist : entry + slDist);
    const tp = round2(side === 'buy' ? entry + tpDist : entry - tpDist);

    const acc = this.broker.getAccountInfo();
    const riskUsd = acc.equity * (cfg.riskPercent / 100);
    let volume = riskUsd / (slDist * CONTRACT_SIZE);
    volume = Math.max(cfg.minLot, Math.min(cfg.maxLot, Math.floor(volume * 100) / 100));

    this._log('signal', `SINYAL ${side.toUpperCase()} — ${reason} | ATR ${atrVal.toFixed(2)} | entry ~${entry} SL ${sl} TP ${tp} | ${volume} lot (risk ${fmtUsd(riskUsd)})`);
    const pos = await this.broker.marketOrder(side, volume, sl, tp, 'GoldScalper ' + cfg.timeframe);
    this.lastEntryAt = now;
    this._log('success', `ORDER TEREKSEKUSI #${pos.id}: ${side.toUpperCase()} ${volume} lot @ ${pos.openPrice}`);
  }

  /** Menghitung sinyal dari candle yang sudah close. Return {side, atrVal, reason} | null */
  _computeSignal(closed) {
    const closes = closed.map(c => c.close);
    const e9s = emaSeries(closes, 9);
    const e21s = emaSeries(closes, 21);
    const e50 = emaSeries(closes, 50);
    const n = closes.length - 1;
    const e9 = e9s[n], e21 = e21s[n], e50v = e50[n];
    if (e9 === null || e21 === null || e50v === null) return null;

    const r = rsi(closes.slice(-40), 14);
    const a = atr(closed, 14);
    if (r === null || !a || a <= 0) return null;

    const c = closed[n];
    const body = c.close - c.open;

    // fresh crossover dalam <=3 candle terakhir
    let crossedUp = false, crossedDown = false;
    for (let i = n; i > n - 3 && i > 0; i--) {
      if (e9s[i] !== null && e21s[i] !== null && e9s[i - 1] !== null && e21s[i - 1] !== null) {
        if (e9s[i] > e21s[i] && e9s[i - 1] <= e21s[i - 1]) crossedUp = true;
        if (e9s[i] < e21s[i] && e9s[i - 1] >= e21s[i - 1]) crossedDown = true;
      }
    }
    // pullback: candle sempat menyentuh EMA9 lalu close kembali searah trend
    const pullbackUp = e9 > e21 && c.low <= e9s[n - 1] && c.close > e9;
    const pullbackDown = e9 < e21 && c.high >= e9s[n - 1] && c.close < e9;

    const bullTrend = e9 > e21 && c.close > e50v;
    const bearTrend = e9 < e21 && c.close < e50v;
    const minBody = 0.25 * a;

    if (bullTrend && (crossedUp || pullbackUp) && r > 50 && r < 72 && body > minBody) {
      return { side: 'buy', atrVal: a, reason: crossedUp ? 'EMA9 cross di atas EMA21 + RSI ' + r.toFixed(1) : 'pullback EMA9 dalam uptrend + RSI ' + r.toFixed(1) };
    }
    if (bearTrend && (crossedDown || pullbackDown) && r < 50 && r > 28 && -body > minBody) {
      return { side: 'sell', atrVal: a, reason: crossedDown ? 'EMA9 cross di bawah EMA21 + RSI ' + r.toFixed(1) : 'pullback EMA9 dalam downtrend + RSI ' + r.toFixed(1) };
    }
    return null;
  }

  _log(level, message) {
    this.emit('log', { time: Date.now(), level, message });
  }
}

function round2(x) { return Math.round(x * 100) / 100; }
function fmtUsd(x) { return (x >= 0 ? '+$' : '-$') + Math.abs(x).toFixed(2); }

module.exports = { GoldScalperBot, DEFAULT_CONFIG };
