//+------------------------------------------------------------------+
//|                                                  GoldScalper.mq5 |
//|        Bot scalping XAU/USD — EMA 9/21/50 + RSI 14 + ATR 14      |
//|        Versi EA dari GoldScalper (exnessbot web), tanpa MetaApi  |
//+------------------------------------------------------------------+
#property copyright "exnessbot"
#property version   "1.00"
#property description "Scalping XAU/USD di M1/M5: crossover/pullback EMA9-21 + filter EMA50,"
#property description "RSI 50-72/28-50, body >= 25% ATR. SL 1.5xATR, TP 1.1xATR,"
#property description "break-even, trailing stop, lot dari risk %, proteksi rugi harian."

#include <Trade\Trade.mqh>

//--- input strategi
input ENUM_TIMEFRAMES InpTimeframe        = PERIOD_CURRENT; // Timeframe sinyal (M1/M5)
input double          InpRiskPercent      = 1.0;            // Risk per trade (% equity)
input double          InpMinLot           = 0.01;           // Lot minimum
input double          InpMaxLot           = 2.0;            // Lot maksimum
input int             InpMaxPositions     = 2;              // Maks posisi terbuka (EA ini)
input double          InpMaxSpreadUSD     = 0.40;           // Maks spread ($)
input double          InpSlAtr            = 1.5;            // SL (x ATR)
input double          InpTpAtr            = 1.1;            // TP (x ATR)
input double          InpBreakEvenAtr     = 0.5;            // Break-even setelah profit (x ATR)
input double          InpTrailStartAtr    = 0.8;            // Trailing mulai setelah profit (x ATR)
input double          InpTrailAtr         = 0.8;            // Jarak trailing (x ATR)
input int             InpCooldownSec      = 45;             // Jeda minimal antar entry (detik)
input double          InpMaxDailyLossPct  = 5.0;            // Stop harian jika rugi >= % equity awal hari
input double          InpDailyTargetPct   = 0.0;            // Target profit harian % (0 = nonaktif)
input long            InpMagic            = 987001;         // Magic number
input int             InpSlippagePoints   = 30;             // Slippage maks (point)

//--- global
CTrade   trade;
int      hEmaFast = INVALID_HANDLE;
int      hEmaSlow = INVALID_HANDLE;
int      hEmaTrend = INVALID_HANDLE;
int      hRsi = INVALID_HANDLE;
int      hAtr = INVALID_HANDLE;
datetime g_lastBarTime   = 0;
datetime g_lastEntryTime = 0;
int      g_dayKey        = 0;
double   g_dayStartEquity = 0.0;
bool     g_haltedToday   = false;
string   g_haltReason    = "";
int      g_wins = 0, g_losses = 0;
double   g_totalProfit = 0.0;

//+------------------------------------------------------------------+
int OnInit()
  {
   ENUM_TIMEFRAMES tf = Timeframe();
   hEmaFast  = iMA(_Symbol, tf, 9,  0, MODE_EMA, PRICE_CLOSE);
   hEmaSlow  = iMA(_Symbol, tf, 21, 0, MODE_EMA, PRICE_CLOSE);
   hEmaTrend = iMA(_Symbol, tf, 50, 0, MODE_EMA, PRICE_CLOSE);
   hRsi      = iRSI(_Symbol, tf, 14, PRICE_CLOSE);
   hAtr      = iATR(_Symbol, tf, 14);
   if(hEmaFast==INVALID_HANDLE || hEmaSlow==INVALID_HANDLE || hEmaTrend==INVALID_HANDLE ||
      hRsi==INVALID_HANDLE || hAtr==INVALID_HANDLE)
     {
      Print("GoldScalper: gagal membuat handle indikator");
      return(INIT_FAILED);
     }

   trade.SetExpertMagicNumber(InpMagic);
   trade.SetDeviationInPoints(InpSlippagePoints);
   trade.SetTypeFillingBySymbol(_Symbol);

   ResetDay();
   Print("GoldScalper AKTIF di ", _Symbol, " ", EnumToString(tf),
         " — risk ", DoubleToString(InpRiskPercent,1), "%/trade. Trading otomatis tanpa konfirmasi.");
   return(INIT_SUCCEEDED);
  }

//+------------------------------------------------------------------+
void OnDeinit(const int reason)
  {
   IndicatorRelease(hEmaFast);
   IndicatorRelease(hEmaSlow);
   IndicatorRelease(hEmaTrend);
   IndicatorRelease(hRsi);
   IndicatorRelease(hAtr);
   Comment("");
  }

//+------------------------------------------------------------------+
void OnTick()
  {
   CheckDayRollover();
   ManagePositions();      // break-even + trailing tiap tick
   CheckDailyGuards();

   if(!g_haltedToday && IsNewBar())
      TryEnter();          // sinyal hanya dievaluasi saat candle close

   UpdatePanel();
  }

//+------------------------------------------------------------------+
ENUM_TIMEFRAMES Timeframe()
  {
   return (InpTimeframe==PERIOD_CURRENT) ? (ENUM_TIMEFRAMES)_Period : InpTimeframe;
  }

//+------------------------------------------------------------------+
bool IsNewBar()
  {
   datetime t = iTime(_Symbol, Timeframe(), 0);
   if(t == g_lastBarTime) return false;
   g_lastBarTime = t;
   return true;
  }

//+------------------------------------------------------------------+
void CheckDayRollover()
  {
   MqlDateTime dt;
   TimeToStruct(TimeCurrent(), dt);
   int key = dt.year*10000 + dt.mon*100 + dt.day;
   if(key != g_dayKey)
      ResetDay();
  }

void ResetDay()
  {
   MqlDateTime dt;
   TimeToStruct(TimeCurrent(), dt);
   g_dayKey = dt.year*10000 + dt.mon*100 + dt.day;
   g_dayStartEquity = AccountInfoDouble(ACCOUNT_EQUITY);
   g_haltedToday = false;
   g_haltReason = "";
  }

//+------------------------------------------------------------------+
void CheckDailyGuards()
  {
   if(g_haltedToday || g_dayStartEquity <= 0) return;
   double pl = AccountInfoDouble(ACCOUNT_EQUITY) - g_dayStartEquity;

   if(InpMaxDailyLossPct > 0 && pl <= -(InpMaxDailyLossPct/100.0)*g_dayStartEquity)
     {
      g_haltedToday = true;
      g_haltReason = StringFormat("proteksi harian: rugi %.2f menembus %.1f%%", pl, InpMaxDailyLossPct);
      Print("GoldScalper STOP hari ini — ", g_haltReason);
     }
   if(InpDailyTargetPct > 0 && pl >= (InpDailyTargetPct/100.0)*g_dayStartEquity)
     {
      g_haltedToday = true;
      g_haltReason = StringFormat("target harian tercapai: +%.2f", pl);
      Print("GoldScalper STOP hari ini — ", g_haltReason);
     }
  }

//+------------------------------------------------------------------+
int CountMyPositions()
  {
   int n = 0;
   for(int i = PositionsTotal()-1; i >= 0; i--)
     {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      if(PositionGetString(POSITION_SYMBOL) == _Symbol &&
         PositionGetInteger(POSITION_MAGIC) == InpMagic)
         n++;
     }
   return n;
  }

//+------------------------------------------------------------------+
//| Break-even + trailing stop untuk semua posisi milik EA ini       |
//+------------------------------------------------------------------+
void ManagePositions()
  {
   double atrBuf[];
   ArraySetAsSeries(atrBuf, true);
   if(CopyBuffer(hAtr, 0, 0, 3, atrBuf) < 3) return;
   double atr = atrBuf[1];                       // ATR candle yang sudah close
   if(atr <= 0) return;

   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double stopsDist = (double)SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL) * _Point;
   double beBuffer = 5.0 * PipUnit();            // buffer 5 sen menutup biaya

   for(int i = PositionsTotal()-1; i >= 0; i--)
     {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      if(PositionGetString(POSITION_SYMBOL) != _Symbol) continue;
      if(PositionGetInteger(POSITION_MAGIC) != InpMagic) continue;

      long   type = PositionGetInteger(POSITION_TYPE);
      double open = PositionGetDouble(POSITION_PRICE_OPEN);
      double sl   = PositionGetDouble(POSITION_SL);
      double tp   = PositionGetDouble(POSITION_TP);
      int    dir  = (type == POSITION_TYPE_BUY) ? 1 : -1;
      double cur  = (dir == 1) ? bid : ask;
      double gain = (cur - open) * dir;

      double newSl = 0.0;
      bool   hasNew = false;

      // break-even
      if(gain >= InpBreakEvenAtr * atr)
        {
         double be = open + dir * beBuffer;
         if(sl == 0.0 || (sl - be) * dir < 0) { newSl = be; hasNew = true; }
        }
      // trailing
      if(gain >= InpTrailStartAtr * atr)
        {
         double tr = cur - dir * InpTrailAtr * atr;
         if(!hasNew || (tr - newSl) * dir > 0)
            if(sl == 0.0 || (tr - sl) * dir > PipUnit()) { newSl = tr; hasNew = true; }
        }
      if(!hasNew) continue;

      // hormati jarak minimum broker & jangan mundur
      if(dir == 1  && newSl > bid - stopsDist) newSl = bid - stopsDist;
      if(dir == -1 && newSl < ask + stopsDist) newSl = ask + stopsDist;
      newSl = NormalizeDouble(newSl, _Digits);
      if(sl != 0.0 && (newSl - sl) * dir <= 0) continue;

      if(trade.PositionModify(ticket, newSl, tp))
         Print("GoldScalper trailing #", ticket, ": SL -> ", DoubleToString(newSl, _Digits));
     }
  }

//+------------------------------------------------------------------+
//| Evaluasi sinyal pada candle close, lalu entry otomatis           |
//+------------------------------------------------------------------+
void TryEnter()
  {
   if(!TradingAllowed()) return;
   if((long)TimeCurrent() - (long)g_lastEntryTime < InpCooldownSec) return;
   if(CountMyPositions() >= InpMaxPositions) return;

   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   if(ask - bid > InpMaxSpreadUSD) return;       // filter spread (USD)

   //--- ambil data indikator (index 1 = candle yang baru saja close)
   double emaF[], emaS[], emaT[], rsiB[], atrB[];
   MqlRates rates[];
   ArraySetAsSeries(emaF, true); ArraySetAsSeries(emaS, true);
   ArraySetAsSeries(emaT, true); ArraySetAsSeries(rsiB, true);
   ArraySetAsSeries(atrB, true); ArraySetAsSeries(rates, true);
   ENUM_TIMEFRAMES tf = Timeframe();
   if(CopyBuffer(hEmaFast, 0, 0, 6, emaF) < 6) return;
   if(CopyBuffer(hEmaSlow, 0, 0, 6, emaS) < 6) return;
   if(CopyBuffer(hEmaTrend, 0, 0, 3, emaT) < 3) return;
   if(CopyBuffer(hRsi, 0, 0, 3, rsiB) < 3) return;
   if(CopyBuffer(hAtr, 0, 0, 3, atrB) < 3) return;
   if(CopyRates(_Symbol, tf, 0, 3, rates) < 3) return;

   double atr = atrB[1];
   double rsi = rsiB[1];
   if(atr <= 0) return;

   double body    = rates[1].close - rates[1].open;
   double minBody = 0.25 * atr;

   //--- fresh crossover EMA9/21 dalam <= 3 candle terakhir
   bool crossedUp = false, crossedDown = false;
   for(int k = 1; k <= 3; k++)
     {
      if(emaF[k] > emaS[k] && emaF[k+1] <= emaS[k+1]) crossedUp = true;
      if(emaF[k] < emaS[k] && emaF[k+1] >= emaS[k+1]) crossedDown = true;
     }
   //--- pullback ke EMA9 yang ditutup searah trend
   bool pullbackUp   = emaF[1] > emaS[1] && rates[1].low  <= emaF[2] && rates[1].close > emaF[1];
   bool pullbackDown = emaF[1] < emaS[1] && rates[1].high >= emaF[2] && rates[1].close < emaF[1];

   bool bullTrend = emaF[1] > emaS[1] && rates[1].close > emaT[1];
   bool bearTrend = emaF[1] < emaS[1] && rates[1].close < emaT[1];

   int signal = 0; // 1 = buy, -1 = sell
   string reason = "";
   if(bullTrend && (crossedUp || pullbackUp) && rsi > 50 && rsi < 72 && body > minBody)
     {
      signal = 1;
      reason = crossedUp ? "EMA9 cross atas EMA21" : "pullback EMA9 uptrend";
     }
   else if(bearTrend && (crossedDown || pullbackDown) && rsi < 50 && rsi > 28 && -body > minBody)
     {
      signal = -1;
      reason = crossedDown ? "EMA9 cross bawah EMA21" : "pullback EMA9 downtrend";
     }
   if(signal == 0) return;

   //--- SL/TP dari ATR
   double entry  = (signal == 1) ? ask : bid;
   double slDist = InpSlAtr * atr;
   double tpDist = InpTpAtr * atr;
   double sl = NormalizeDouble(entry - signal * slDist, _Digits);
   double tp = NormalizeDouble(entry + signal * tpDist, _Digits);

   //--- lot dari risk % equity terhadap jarak SL
   double volume = CalcVolume(slDist);
   if(volume <= 0) return;

   PrintFormat("GoldScalper SINYAL %s — %s | RSI %.1f | ATR %.2f | entry ~%.2f SL %.2f TP %.2f | %.2f lot",
               signal==1 ? "BUY" : "SELL", reason, rsi, atr, entry, sl, tp, volume);

   bool ok = (signal == 1)
             ? trade.Buy(volume, _Symbol, 0.0, sl, tp, "GoldScalper")
             : trade.Sell(volume, _Symbol, 0.0, sl, tp, "GoldScalper");
   if(ok)
     {
      g_lastEntryTime = TimeCurrent();
      Print("GoldScalper ORDER TEREKSEKUSI: ", signal==1 ? "BUY " : "SELL ", DoubleToString(volume,2), " lot");
     }
   else
      Print("GoldScalper order GAGAL: ", trade.ResultRetcode(), " / ", trade.ResultRetcodeDescription());
  }

//+------------------------------------------------------------------+
double CalcVolume(double slDist)
  {
   double tickVal  = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
   double tickSize = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   if(tickVal <= 0 || tickSize <= 0 || slDist <= 0) return 0;

   double lossPerLot = slDist / tickSize * tickVal;      // kerugian per 1.0 lot jika SL kena
   double riskMoney  = AccountInfoDouble(ACCOUNT_EQUITY) * InpRiskPercent / 100.0;
   double vol = riskMoney / lossPerLot;

   double step   = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   double volMin = MathMax(SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN), InpMinLot);
   double volMax = MathMin(SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX), InpMaxLot);
   if(step > 0) vol = MathFloor(vol / step) * step;
   vol = MathMax(volMin, MathMin(volMax, vol));
   return NormalizeDouble(vol, 2);
  }

//+------------------------------------------------------------------+
bool TradingAllowed()
  {
   if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED)) return false;   // tombol Algo Trading
   if(!MQLInfoInteger(MQL_TRADE_ALLOWED)) return false;
   if(!AccountInfoInteger(ACCOUNT_TRADE_ALLOWED)) return false;
   return true;
  }

//+------------------------------------------------------------------+
double PipUnit()
  {
   // "5 sen" untuk gold (digit 2/3); fallback 5 point untuk simbol lain
   return (_Digits <= 3) ? 0.05 : 5.0 * _Point;
  }

//+------------------------------------------------------------------+
void UpdatePanel()
  {
   double eq = AccountInfoDouble(ACCOUNT_EQUITY);
   double pl = eq - g_dayStartEquity;
   string status = g_haltedToday ? ("BERHENTI HARI INI (" + g_haltReason + ")")
                                 : (TradingAllowed() ? "AKTIF — trading otomatis" : "NONAKTIF — nyalakan tombol Algo Trading!");
   Comment(
      "GoldScalper — ", _Symbol, " ", EnumToString(Timeframe()), "\n",
      "Status   : ", status, "\n",
      "Equity   : ", DoubleToString(eq, 2), "  |  P/L hari ini: ", DoubleToString(pl, 2), "\n",
      "Posisi EA: ", IntegerToString(CountMyPositions()), "/", IntegerToString(InpMaxPositions),
      "  |  Spread: ", DoubleToString(SymbolInfoDouble(_Symbol, SYMBOL_ASK) - SymbolInfoDouble(_Symbol, SYMBOL_BID), 2), "\n",
      "Risk     : ", DoubleToString(InpRiskPercent, 1), "%/trade  |  SL ", DoubleToString(InpSlAtr, 1),
      "xATR  TP ", DoubleToString(InpTpAtr, 1), "xATR  |  Proteksi harian ", DoubleToString(InpMaxDailyLossPct, 1), "%"
   );
  }
//+------------------------------------------------------------------+
