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
  aggressive: false,      // true = filter longgar, entry jauh lebih sering di M1
  riskPercent: 1.0,       // % equity yang dirisikokan per trade
  maxLot: 2.0,
  minLot: 0.01,
  maxPositions: 2,        // 0 = tanpa batas (dibatasi hanya oleh margin bebas)
  minFreeMarginPct: 20,   // berhenti buka posisi baru bila free margin < % equity ini
  maxSpread: 0.4,         // USD
  slAtr: 1.5,             // SL = slAtr x ATR
  tpAtr: 1.1,             // TP = tpAtr x ATR
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
      if (!(k in DEFAULT_CONFIG)) continue;
      if (k === 'symbol' || k === 'timeframe') {
        if (cfg[k]) this.config[k] = cfg[k];
      } else if (k === 'aggressive') {
        this.config[k] = cfg[k] === true || cfg[k] === 'true' || cfg[k] === 1 || cfg[k] === '1';
      } else {
        const v = Number(cfg[k]);
        if (!isNaN(v)) this.config[k] = v;
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

    // batas jumlah posisi: 0 = tak terbatas (dijaga oleh free margin)
    const botPositions = this.broker.getPositions().filter(p => String(p.comment || '').includes('GoldScalper'));
    if (cfg.maxPositions > 0 && botPositions.length >= cfg.maxPositions) return;

    // penjaga margin: berhenti buka posisi baru bila margin bebas menipis,
    // supaya order tidak ditolak broker (yang membuat bot "seolah macet")
    const acc = this.broker.getAccountInfo();
    if (cfg.minFreeMarginPct > 0 && acc.equity > 0) {
      const freePct = (acc.freeMargin / acc.equity) * 100;
      if (isFinite(freePct) && freePct < cfg.minFreeMarginPct) {
        if (now - (this._lastMarginWarn || 0) > 60000) {
          this._lastMarginWarn = now;
          this._log('warn', `Margin bebas ${freePct.toFixed(0)}% < ${cfg.minFreeMarginPct}% — jeda buka posisi baru sampai margin pulih.`);
        }
        return;
      }
    }

    const q = this.broker.getQuote();
    if (!q || !q.bid) return;
    if (q.spread > cfg.maxSpread) return;

    // warmup adaptif: mode agresif butuh lebih sedikit candle -> live bisa mulai
    // trading jauh lebih cepat (sebelumnya butuh 80 candle = ~80 menit di M1)
    const minBars = cfg.aggressive ? 30 : 80;
    const candles = this.broker.getCandles(cfg.timeframe, 260);
    if (candles.length < minBars) return;
    const closed = candles.slice(0, -1); // hanya candle yang sudah close
    const lastCandle = closed[closed.length - 1];
    if (this.lastSignalCandle === lastCandle.time) return; // satu evaluasi per candle

    const signal = cfg.aggressive ? this._computeSignalAggressive(closed) : this._computeSignal(closed);
    this.lastSignalCandle = lastCandle.time;
    if (!signal) return;

    const { side, atrVal, reason } = signal;
    const entry = side === 'buy' ? q.ask : q.bid;
    const slDist = cfg.slAtr * atrVal;
    const tpDist = cfg.tpAtr * atrVal;
    const sl = round2(side === 'buy' ? entry - slDist : entry + slDist);
    const tp = round2(side === 'buy' ? entry + tpDist : entry - tpDist);

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

  /**
   * Sinyal AGRESIF untuk M1: filter jauh lebih longgar sehingga entry sering.
   * Cukup arah EMA cepat (EMA5 vs EMA13) + konfirmasi momentum candle terakhir,
   * tanpa syarat crossover fresh / EMA50 / body minimal ketat.
   *
   * CATATAN JUJUR: lebih sering entry != lebih akurat. Filter yang dilonggarkan
   * menaikkan frekuensi tapi menurunkan kualitas rata-rata sinyal. Gunakan
   * bersama SL/TP dan manajemen risiko, bukan sebagai jaminan profit.
   */
  _computeSignalAggressive(closed) {
    const closes = closed.map(c => c.close);
    const eFast = emaSeries(closes, 5);
    const eSlow = emaSeries(closes, 13);
    const n = closes.length - 1;
    const ef = eFast[n], es = eSlow[n];
    if (ef === null || es === null) return null;

    const a = atr(closed, 14);
    if (!a || a <= 0) return null;
    const r = rsi(closes.slice(-30), 14);
    if (r === null) return null;

    const c = closed[n];
    const prev = closed[n - 1];
    const body = c.close - c.open;

    // arah dari EMA cepat + candle terakhir searah + tidak di kondisi ekstrem RSI
    const upSlope = ef > es && eFast[n - 1] !== null && ef >= eFast[n - 1];
    const downSlope = ef < es && eFast[n - 1] !== null && ef <= eFast[n - 1];

    if (upSlope && c.close > c.open && c.close >= prev.high - 0.1 * a && r < 78) {
      return { side: 'buy', atrVal: a, reason: 'agresif M1: EMA5>EMA13 naik + candle bullish (RSI ' + r.toFixed(0) + ')' };
    }
    if (downSlope && c.close < c.open && c.close <= prev.low + 0.1 * a && r > 22) {
      return { side: 'sell', atrVal: a, reason: 'agresif M1: EMA5<EMA13 turun + candle bearish (RSI ' + r.toFixed(0) + ')' };
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
