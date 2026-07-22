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
  aggressive: true,       // true = filter longgar, entry jauh lebih sering di M1
  entryMode: 'meanRev',   // 'signal' | 'candleOpen' | 'meanRev' (scalping winrate tinggi)
  riskPercent: 1.0,       // % equity yang dirisikokan per trade
  maxLot: 2.0,
  minLot: 0.01,
  maxPositions: 2,        // 0 = tanpa batas (dibatasi hanya oleh margin bebas)
  minFreeMarginPct: 20,   // berhenti buka posisi baru bila free margin < % equity ini
  maxSpread: 0.6,         // USD (dinaikkan agar tidak memblokir entry di live)
  slAtr: 1.5,             // SL = slAtr x ATR
  tpAtr: 1.5,             // TP = tpAtr x ATR (1:1 dengan SL)
  useMoneyStops: false,   // true = tutup posisi pada nominal rupiah tetap (bukan ATR)
  tpIdr: 20000,           // tutup posisi bila profit >= nominal IDR ini
  slIdr: 20000,           // tutup posisi bila rugi >= nominal IDR ini
  breakEvenIdr: 10000,    // bila profit >= IDR ini, geser SL ke entry (0 = off)
  usdIdrRate: 16000,      // kurs USD->IDR utk konversi (P/L broker dlm USD)
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
      } else if (k === 'entryMode') {
        this.config[k] = ['candleOpen', 'meanRev', 'signal'].includes(cfg[k]) ? cfg[k] : 'signal';
      } else if (k === 'aggressive' || k === 'useMoneyStops') {
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
      await this._protectPositions();  // break-even + penegakan SL/TP (semua mode)
      await this._checkMoneyStops();   // tutup ±nominal IDR (mode nominal)
      if (!this._checkDailyGuards()) return;
      await this._managePositions();   // trailing ATR (mode ATR)
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

  /**
   * Tutup posisi bila P/L menyentuh nominal rupiah + geser SL ke break-even.
   * Dicek TIAP TICK berdasarkan P/L broker (USD -> IDR via usdIdrRate) agar
   * exit akurat, tidak bergantung pembulatan harga SL/TP di sisi broker.
   */
  async _checkMoneyStops() {
    const cfg = this.config;
    if (!cfg.useMoneyStops) return;
    const rate = cfg.usdIdrRate > 0 ? cfg.usdIdrRate : 16000;
    const q = this.broker.getQuote();
    const spread = q && q.spread ? q.spread : 0.05;

    const nowTs = Date.now();
    for (const p of this.broker.getPositions()) {
      if (!p.comment || !String(p.comment).includes('GoldScalper')) continue;
      // jangan bertindak atas posisi pending (P/L masih estimasi, belum sinkron)
      if (p.pending) continue;
      // grace 2 detik: hindari spike spread/sinkron saat baru entry memicu SL palsu
      if (p.openTime && nowTs - p.openTime < 2000) continue;
      const plIdr = (p.profit || 0) * rate;

      // exit nominal — pengecekan utama, presisi ke P/L nyata
      if (cfg.tpIdr > 0 && plIdr >= cfg.tpIdr) {
        await this.broker.closePosition(p.id, 'tp-idr');
        this._log('success', `TP nominal tercapai #${p.id}: +${Math.round(plIdr).toLocaleString('id-ID')} IDR — posisi ditutup.`);
        continue;
      }
      if (cfg.slIdr > 0 && plIdr <= -cfg.slIdr) {
        await this.broker.closePosition(p.id, 'sl-idr');
        this._log('error', `SL nominal tersentuh #${p.id}: ${Math.round(plIdr).toLocaleString('id-ID')} IDR — posisi ditutup.`);
        continue;
      }

      // break-even: begitu profit >= breakEvenIdr, geser SL ke entry (+buffer spread)
      if (cfg.breakEvenIdr > 0 && plIdr >= cfg.breakEvenIdr) {
        const dir = p.side === 'buy' ? 1 : -1;
        const beSl = round2(p.openPrice + dir * (spread + 0.02)); // kunci ~0, tutup biaya spread
        // hanya geser bila SL belum di BE atau masih lebih buruk dari BE
        if (p.sl === null || (beSl - p.sl) * dir > 0.001) {
          try {
            await this.broker.modifyPosition(p.id, beSl, p.tp);
            this._log('info', `Break-even #${p.id}: profit +${Math.round(plIdr).toLocaleString('id-ID')} IDR — SL digeser ke ${beSl} (aman dari rugi).`);
          } catch (e) { /* broker mungkin menolak SL terlalu dekat; monitor tick tetap menjaga */ }
        }
      }
    }
  }

  /** Break-even + trailing stop untuk posisi milik bot. */
  async _managePositions() {
    // saat pakai money-stops, exit dikendalikan nominal IDR (bukan trailing ATR)
    if (this.config.useMoneyStops) return;
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

  /**
   * Proteksi universal (semua mode, dicek TIAP TICK):
   *  1. Break-even: begitu posisi profit >= 40% jarak ke TP, SL digeser ke
   *     titik entry (+buffer spread) — posisi tidak bisa lagi berbalik rugi.
   *  2. Penegakan SL/TP sisi-bot: bila harga (feed kita) menyentuh level SL/TP,
   *     posisi langsung ditutup — cadangan bila SL/TP broker telat/tak terpasang,
   *     mengurangi exit yang "meleset".
   */
  async _protectPositions() {
    const q = this.broker.getQuote();
    if (!q || !q.bid) return;
    const spread = q.spread || 0.05;
    const nowTs = Date.now();

    for (const p of this.broker.getPositions()) {
      if (!p.comment || !String(p.comment).includes('GoldScalper')) continue;
      if (p.pending) continue;                         // jangan tutup posisi yg blm sinkron
      const dir = p.side === 'buy' ? 1 : -1;
      const cur = p.side === 'buy' ? q.bid : q.ask;

      // 1) penegakan level: tutup segera bila harga sudah menyentuh TP/SL
      if (p.tp && (cur - p.tp) * dir >= 0) {
        await this.broker.closePosition(p.id, 'tp');
        this._log('success', `TP tersentuh #${p.id} @ ${cur} — posisi ditutup.`);
        continue;
      }
      if (p.sl && (p.sl - cur) * dir >= 0) {
        await this.broker.closePosition(p.id, 'sl');
        const profitable = (cur - p.openPrice) * dir >= 0; // SL di atas entry (break-even/profit)?
        this._log(profitable ? 'success' : 'error', `SL tersentuh #${p.id} @ ${cur} — posisi ditutup${profitable ? ' (terkunci aman)' : ''}.`);
        continue;
      }

      // 2) break-even RATCHET: setelah profit menembus 40% jarak ke TP, SL
      //    mengunci profit dan HANYA bergeser ke arah profit lebih tinggi —
      //    tidak pernah mundur meski harga berbalik (grace 2s dulu).
      if (nowTs - (p.openTime || 0) < 2000) continue;
      if (p.tp) {
        const distTP = Math.abs(p.tp - p.openPrice);
        const gain = (cur - p.openPrice) * dir;
        if (distTP > 0 && gain >= 0.4 * distTP) {
          // profit yang dikunci = kelebihan di atas ambang 0.4*TP, minimal break-even
          const lockedProfit = Math.max(spread + 0.02, gain - 0.4 * distTP);
          const newSl = round2(p.openPrice + dir * lockedProfit);
          // ratchet: hanya geser bila LEBIH menguntungkan dari SL sekarang
          if (p.sl === null || (newSl - p.sl) * dir > 0.001) {
            try {
              await this.broker.modifyPosition(p.id, newSl, p.tp);
              this._log('info', `Break-even naik #${p.id}: SL -> ${newSl} (kunci profit, hanya bergerak naik).`);
            } catch (e) { /* broker menolak SL terlalu dekat; penegakan level tetap menjaga */ }
          }
        }
      }
    }
  }

  /** Catat alasan blokir ke Journal, tapi throttle agar tidak spam (per alasan). */
  _blocked(reason) {
    const now = Date.now();
    this._blockLast = this._blockLast || {};
    if (now - (this._blockLast[reason] || 0) > 30000) {
      this._blockLast[reason] = now;
      this._log('info', 'Belum entry — ' + reason);
    }
  }

  async _maybeEnter() {
    const cfg = this.config;
    const now = Date.now();
    if ((now - this.lastEntryAt) / 1000 < cfg.cooldownSec) return;

    // batas jumlah posisi: 0 = tak terbatas (dijaga oleh free margin)
    const botPositions = this.broker.getPositions().filter(p => String(p.comment || '').includes('GoldScalper'));
    if (cfg.maxPositions > 0 && botPositions.length >= cfg.maxPositions) {
      this._blocked(`sudah ${botPositions.length}/${cfg.maxPositions} posisi (set Maks posisi = 0 utk tak terbatas)`);
      return;
    }

    // penjaga margin: berhenti buka posisi baru bila margin bebas menipis,
    // supaya order tidak ditolak broker (yang membuat bot "seolah macet")
    const acc = this.broker.getAccountInfo();
    if (cfg.minFreeMarginPct > 0 && acc.equity > 0) {
      const freePct = (acc.freeMargin / acc.equity) * 100;
      if (isFinite(freePct) && freePct < cfg.minFreeMarginPct) {
        this._blocked(`margin bebas ${freePct.toFixed(0)}% < ${cfg.minFreeMarginPct}% — tunggu margin pulih`);
        return;
      }
    }

    const q = this.broker.getQuote();
    if (!q || !q.bid) { this._blocked('belum ada harga (pasar mungkin tutup / belum sinkron)'); return; }
    if (q.spread > cfg.maxSpread) {
      this._blocked(`spread $${q.spread.toFixed(2)} > maks $${cfg.maxSpread} — naikkan "Maks spread" di ⚙`);
      return;
    }

    // warmup adaptif: candleOpen paling ringan (butuh sedikit bar utk ATR)
    const minBars = cfg.entryMode === 'candleOpen' ? 16 : (cfg.aggressive ? 30 : 80);
    const candles = this.broker.getCandles(cfg.timeframe, 260);
    if (candles.length < minBars) {
      this._blocked(`mengumpulkan candle ${candles.length}/${minBars} (butuh ~${minBars} menit di M1 kalau riwayat kosong)`);
      return;
    }
    const closed = candles.slice(0, -1); // hanya candle yang sudah close
    const lastCandle = closed[closed.length - 1];
    if (this.lastSignalCandle === lastCandle.time) return; // satu evaluasi per candle

    let signal;
    if (cfg.entryMode === 'meanRev') signal = this._computeSignalMeanReversion(closed);
    else if (cfg.entryMode === 'candleOpen') signal = this._computeSignalCandleOpen(closed);
    else signal = cfg.aggressive ? this._computeSignalAggressive(closed) : this._computeSignal(closed);
    this.lastSignalCandle = lastCandle.time;
    if (!signal) { this._blocked('candle close terbaru belum memenuhi kondisi sinyal'); return; }

    const { side, atrVal, reason } = signal;
    const entry = side === 'buy' ? q.ask : q.bid;
    const slDist = cfg.slAtr * atrVal;        // jarak SL berbasis ATR (di luar spread)
    let volume, sl, tp, exitInfo, sizeInfo;

    if (cfg.useMoneyStops) {
      // Ukuran lot dihitung DARI nominal IDR + jarak ATR, supaya jarak SL selalu
      // wajar (di luar spread) dan kerugian di SL ≈ slIdr. Ini mencegah posisi
      // langsung ketutup: dulu lot dari risk% bisa besar sehingga biaya spread
      // (dalam IDR) melampaui slIdr dan posisi dianggap kena SL saat itu juga.
      const rate = cfg.usdIdrRate > 0 ? cfg.usdIdrRate : 16000;
      const slUsd = (cfg.slIdr > 0 ? cfg.slIdr : cfg.tpIdr) / rate;   // rugi target di SL (USD)

      // jarak SL minimal: max(ATR, 3x spread) supaya aman dari spread saat entry
      const safeSlDist = Math.max(slDist, (q.spread || 0.2) * 3, 0.10);
      volume = slUsd / (safeSlDist * CONTRACT_SIZE);
      volume = Math.max(cfg.minLot, Math.min(cfg.maxLot, Math.floor(volume * 100) / 100));

      const perPrice = volume * CONTRACT_SIZE;   // USD per 1.0 pergerakan harga
      const SAFETY = 1.4;                        // SL/TP broker sedikit lebih lebar (jaring pengaman)
      const slDistP = (cfg.slIdr / rate) / perPrice * SAFETY;
      const tpDistP = (cfg.tpIdr / rate) / perPrice * SAFETY;
      sl = cfg.slIdr > 0 ? round2(side === 'buy' ? entry - slDistP : entry + slDistP) : null;
      tp = cfg.tpIdr > 0 ? round2(side === 'buy' ? entry + tpDistP : entry - tpDistP) : null;
      exitInfo = `exit ±IDR (${cfg.slIdr.toLocaleString('id-ID')}/${cfg.tpIdr.toLocaleString('id-ID')}) @ kurs ${rate}, BE ${cfg.breakEvenIdr.toLocaleString('id-ID')}`;
      sizeInfo = `${volume} lot`;
    } else if (signal.targetPrice) {
      // Mean-reversion (winrate tinggi): TP kecil = jarak ke mean (mudah tercapai),
      // SL lebih lebar. Banyak menang kecil; risiko: sesekali rugi lebih besar.
      const tpDist = Math.abs(signal.targetPrice - entry);
      const slDistMr = Math.max(tpDist * 1.8, (q.spread || 0.2) * 4, 0.15);
      const riskUsd = acc.equity * (cfg.riskPercent / 100);
      volume = riskUsd / (slDistMr * CONTRACT_SIZE);
      volume = Math.max(cfg.minLot, Math.min(cfg.maxLot, Math.floor(volume * 100) / 100));
      tp = round2(signal.targetPrice);
      sl = round2(side === 'buy' ? entry - slDistMr : entry + slDistMr);
      exitInfo = `TP ${tp} (mean) SL ${sl} — winrate tinggi`;
      sizeInfo = `${volume} lot (risk ${fmtUsd(riskUsd)})`;
    } else {
      const riskUsd = acc.equity * (cfg.riskPercent / 100);
      volume = riskUsd / (slDist * CONTRACT_SIZE);
      volume = Math.max(cfg.minLot, Math.min(cfg.maxLot, Math.floor(volume * 100) / 100));
      const tpDist = cfg.tpAtr * atrVal;
      sl = round2(side === 'buy' ? entry - slDist : entry + slDist);
      tp = round2(side === 'buy' ? entry + tpDist : entry - tpDist);
      exitInfo = `SL ${sl} TP ${tp}`;
      sizeInfo = `${volume} lot (risk ${fmtUsd(riskUsd)})`;
    }

    this._log('signal', `SINYAL ${side.toUpperCase()} — ${reason} | entry ~${entry} | ${exitInfo} | ${sizeInfo}`);
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

  /**
   * Metode PEMBUKAAN CANDLE — paling agresif: begitu candle M1 baru terbentuk,
   * bot langsung entry mengikuti arah momentum candle yang baru saja close
   * (searah bila candle bullish/bearish; bila doji, ikut arah EMA5 vs EMA13).
   * Nyaris selalu menghasilkan entry tiap menit.
   *
   * CATATAN JUJUR: ini praktis "ikut candle terakhir" — sangat sering entry,
   * tetapi TIDAK memilih kualitas sinyal. Spread & arah acak jangka pendek
   * membuat metode ini mudah rugi kalau winrate tidak di atas ~55%. Uji di
   * akun demo dulu.
   */
  _computeSignalCandleOpen(closed) {
    const n = closed.length - 1;
    const c = closed[n];
    if (!c) return null;

    // ATR untuk SL/TP; fallback ke rata-rata range candle bila belum cukup bar
    let a = atr(closed, 14);
    if (!a || a <= 0) {
      let sum = 0, cnt = 0;
      for (let i = Math.max(0, n - 5); i <= n; i++) { sum += (closed[i].high - closed[i].low); cnt++; }
      a = cnt ? sum / cnt : (c.close * 0.0006); // fallback terakhir ~0.06% harga
    }
    if (!a || a <= 0) return null;

    // arah: candle terakhir bullish -> buy, bearish -> sell, doji -> ikut EMA
    let side;
    if (c.close > c.open) side = 'buy';
    else if (c.close < c.open) side = 'sell';
    else {
      const closes = closed.map(x => x.close);
      const ef = emaSeries(closes, 5)[n];
      const es = emaSeries(closes, 13)[n];
      if (ef === null || es === null) return null;
      side = ef >= es ? 'buy' : 'sell';
    }
    return { side, atrVal: a, reason: 'pembukaan candle: ikut arah candle M1 terakhir' };
  }

  /**
   * Scalping M1 WINRATE TINGGI — mean reversion (fade harga ekstrem).
   * Saat harga menjulur jauh dari rata-rata (keluar Bollinger Band) DAN RSI
   * ekstrem, bot melawan arah menuju kembali ke mean (SMA20) dengan TP kecil.
   * Target = mean -> mudah tercapai -> winrate tinggi. Konfirmasi reversal
   * (candle berbalik) menyaring sinyal. Agresif: pakai band 1.8σ & RSI 38/62.
   *
   * CATATAN JUJUR: winrate tinggi = banyak menang kecil, TAPI risk:reward
   * negatif — sesekali harga menembus terus (SL lebih lebar) dan satu kerugian
   * bisa menghapus beberapa kemenangan. Break-even ratchet & proteksi tetap aktif.
   */
  _computeSignalMeanReversion(closed) {
    const n = closed.length - 1;
    const closes = closed.map(c => c.close);
    if (n < 20) return null;

    // Bollinger Band 20
    const period = 20;
    let sum = 0;
    for (let i = n - period + 1; i <= n; i++) sum += closes[i];
    const mean = sum / period;
    let varSum = 0;
    for (let i = n - period + 1; i <= n; i++) varSum += (closes[i] - mean) ** 2;
    const sd = Math.sqrt(varSum / period);
    if (sd <= 0) return null;
    const upper = mean + 1.8 * sd;
    const lower = mean - 1.8 * sd;

    const r = rsi(closes.slice(-40), 14);
    const a = atr(closed, 14);
    if (r === null || !a || a <= 0) return null;

    const c = closed[n];
    const prev = closed[n - 1];

    // BUY: harga turun jauh di bawah band + RSI oversold + candle mulai berbalik naik
    if (c.close <= lower && r < 38 && c.close >= c.open && c.close > prev.close) {
      return { side: 'buy', atrVal: a, targetPrice: mean,
        reason: `mean-reversion: harga di bawah band (RSI ${r.toFixed(0)}) -> target mean ${round2(mean)}` };
    }
    // SELL: harga naik jauh di atas band + RSI overbought + candle mulai berbalik turun
    if (c.close >= upper && r > 62 && c.close <= c.open && c.close < prev.close) {
      return { side: 'sell', atrVal: a, targetPrice: mean,
        reason: `mean-reversion: harga di atas band (RSI ${r.toFixed(0)}) -> target mean ${round2(mean)}` };
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
