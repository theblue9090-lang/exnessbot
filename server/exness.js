'use strict';

const { EventEmitter } = require('events');

/**
 * Adapter akun Exness (MT5) melalui MetaApi (https://metaapi.cloud).
 *
 * Exness tidak menyediakan API trading publik langsung — akun Exness adalah akun
 * MetaTrader 5, dan MetaApi adalah jembatan cloud resmi untuk mengaksesnya dari
 * aplikasi web. Pengguna login dengan: nomor akun MT5 Exness, password trading,
 * nama server (mis. "Exness-MT5Trial7" / "Exness-MT5Real8"), dan token MetaApi.
 *
 * Adapter ini mengimplementasikan interface broker yang sama dengan simulator,
 * sehingga bot GoldScalper bisa berjalan identik di akun demo maupun real.
 */

const TF_MINUTES = { M1: 1, M5: 5, M15: 15, M30: 30, H1: 60 };
const SYMBOL_CANDIDATES = ['XAUUSD', 'XAUUSDm', 'XAUUSDc', 'XAUUSDz', 'GOLD'];

class ExnessBroker extends EventEmitter {
  constructor() {
    super();
    this.connected = false;
    this.symbol = 'XAUUSD';
    this.m1 = [];
    this.info = null;
  }

  /**
   * @param {{login:string, password:string, server:string, token:string}} creds
   * @param {(msg:string)=>void} onProgress
   */
  async connect(creds, onProgress = () => {}) {
    let MetaApi;
    try {
      MetaApi = require('metaapi.cloud-sdk').default;
    } catch (e) {
      throw new Error(
        'SDK MetaApi belum terpasang. Jalankan "npm install metaapi.cloud-sdk" lalu restart server. ' +
        '(Exness diakses lewat MetaApi karena Exness tidak punya API web publik langsung.)'
      );
    }
    if (!creds.token) throw new Error('Token MetaApi wajib diisi (buat gratis di app.metaapi.cloud).');
    if (!creds.login || !creds.password || !creds.server) throw new Error('Login, password, dan server Exness wajib diisi.');

    const api = new MetaApi(creds.token);
    onProgress('Mencari akun di MetaApi...');
    let account = null;
    try {
      const accounts = await api.metatraderAccountApi.getAccountsWithInfiniteScrollPagination();
      account = accounts.find(a => String(a.login) === String(creds.login) && a.server === creds.server);
    } catch (e) { /* lanjut buat akun baru */ }

    if (!account) {
      onProgress('Mendaftarkan akun Exness ke MetaApi...');
      account = await api.metatraderAccountApi.createAccount({
        name: 'Exness ' + creds.login,
        type: 'cloud',
        login: String(creds.login),
        password: creds.password,
        server: creds.server,
        platform: 'mt5',
        magic: 987001
      });
    }

    onProgress('Deploy akun (bisa 1-3 menit saat pertama kali)...');
    await account.deploy();
    await account.waitConnected();

    onProgress('Membuka koneksi streaming...');
    const connection = account.getStreamingConnection();
    await connection.connect();
    await connection.waitSynchronized({ timeoutInSeconds: 300 });

    // deteksi nama simbol gold yang tersedia di server Exness ini
    onProgress('Mendeteksi simbol XAU/USD...');
    const state = connection.terminalState;
    for (const s of SYMBOL_CANDIDATES) {
      try {
        await connection.subscribeToMarketData(s);
        this.symbol = s;
        break;
      } catch (e) { /* coba kandidat berikutnya */ }
    }

    this.api = api;
    this.account = account;
    this.connection = connection;
    this.state = state;

    onProgress('Mengambil riwayat candle M1...');
    try {
      const candles = await account.getHistoricalCandles(this.symbol, '1m', undefined, 1000);
      this.m1 = (candles || []).map(c => ({
        time: new Date(c.time).getTime(),
        open: c.open, high: c.high, low: c.low, close: c.close,
        volume: c.tickVolume || c.volume || 0
      }));
    } catch (e) {
      onProgress('Gagal ambil riwayat candle (' + e.message + '), candle dibangun dari tick.');
    }

    this.connected = true;
    this._pollTimer = setInterval(() => this._poll(), 500);
    onProgress('Terhubung ke Exness: ' + creds.server + ' #' + creds.login + ' (simbol ' + this.symbol + ')');
    return this;
  }

  async disconnect() {
    this.connected = false;
    clearInterval(this._pollTimer);
    try { if (this.connection) await this.connection.close(); } catch (e) { /* abaikan */ }
  }

  _poll() {
    try {
      const price = this.state.price(this.symbol);
      if (!price || !price.bid) return;
      const now = Date.now();
      const bid = price.bid;
      const spread = Math.round((price.ask - price.bid) * 100) / 100;

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

      this.emit('tick', { symbol: this.symbol, bid, ask: price.ask, spread, time: now });
    } catch (e) { /* tick berikutnya */ }
  }

  // ---------- interface broker ----------

  getQuote() {
    const p = this.state.price(this.symbol) || {};
    const bid = p.bid || 0;
    const ask = p.ask || 0;
    return { symbol: this.symbol, bid, ask, spread: Math.round((ask - bid) * 100) / 100, time: Date.now() };
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
    const a = this.state.accountInformation || {};
    return {
      broker: a.broker || 'Exness',
      login: a.login || '',
      currency: a.currency || 'USD',
      leverage: a.leverage || 0,
      balance: a.balance || 0,
      equity: a.equity || 0,
      margin: a.margin || 0,
      freeMargin: a.freeMargin || 0,
      profit: Math.round(((a.equity || 0) - (a.balance || 0)) * 100) / 100
    };
  }

  getPositions() {
    return (this.state.positions || [])
      .filter(p => p.symbol === this.symbol)
      .map(p => ({
        id: String(p.id),
        symbol: p.symbol,
        side: p.type === 'POSITION_TYPE_BUY' ? 'buy' : 'sell',
        volume: p.volume,
        openPrice: p.openPrice,
        openTime: new Date(p.time).getTime(),
        sl: p.stopLoss || null,
        tp: p.takeProfit || null,
        comment: p.comment || p.clientId || '',
        currentPrice: p.currentPrice,
        profit: Math.round((p.profit || 0) * 100) / 100
      }));
  }

  getHistory() {
    try {
      const deals = this.connection.historyStorage.deals || [];
      return deals
        .filter(d => d.symbol === this.symbol && d.entryType === 'DEAL_ENTRY_OUT')
        .slice(-200)
        .map(d => ({
          id: String(d.positionId || d.id),
          symbol: d.symbol,
          side: d.type === 'DEAL_TYPE_BUY' ? 'sell' : 'buy', // deal keluar berlawanan arah posisi
          volume: d.volume,
          openPrice: null,
          closePrice: d.price,
          closeTime: new Date(d.time).getTime(),
          profit: Math.round((d.profit || 0) * 100) / 100,
          reason: 'exness',
          comment: d.comment || ''
        }));
    } catch (e) {
      return [];
    }
  }

  async marketOrder(side, volume, sl, tp, comment = '') {
    const opts = { comment: String(comment).slice(0, 25) };
    const res = side === 'buy'
      ? await this.connection.createMarketBuyOrder(this.symbol, volume, sl || undefined, tp || undefined, opts)
      : await this.connection.createMarketSellOrder(this.symbol, volume, sl || undefined, tp || undefined, opts);
    this.emit('trade', { event: 'open', position: { id: String(res.positionId || res.orderId), side, volume, comment } });
    return {
      id: String(res.positionId || res.orderId),
      symbol: this.symbol,
      side, volume,
      openPrice: res.price || this.getQuote()[side === 'buy' ? 'ask' : 'bid'],
      openTime: Date.now(),
      sl: sl || null, tp: tp || null,
      comment
    };
  }

  async modifyPosition(id, sl, tp) {
    await this.connection.modifyPosition(id, sl || undefined, tp || undefined);
    return { id, sl, tp };
  }

  async closePosition(id) {
    await this.connection.closePosition(id);
    return { id };
  }
}

module.exports = { ExnessBroker };
