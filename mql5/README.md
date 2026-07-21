# GoldScalper EA (MQL5) — Bot Scalping XAU/USD Tanpa MetaApi

Versi **Expert Advisor** dari bot GoldScalper: strategi yang sama persis dengan
versi web, tetapi berjalan **langsung di terminal MetaTrader 5 Exness** —
**gratis, tanpa MetaApi, tanpa saldo tambahan**. Begitu di-attach ke chart, EA
langsung trading otomatis tanpa konfirmasi.

## Cara Pasang (±5 menit)

1. **Buka MetaTrader 5** yang sudah login akun Exness kamu
   (unduh dari menu *Download MetaTrader 5* di area klien Exness jika belum).
2. Tekan **F4** (MetaEditor) → **File → Open** → pilih `GoldScalper.mq5` →
   tekan **F7** (Compile). Harus muncul `0 errors`.
   - Alternatif: di MT5, **File → Open Data Folder** → masuk `MQL5/Experts/`,
     salin `GoldScalper.mq5` ke sana, restart MT5, lalu compile dari Navigator.
3. Kembali ke MT5, buka **chart XAUUSD** dan pilih **timeframe M1 atau M5**.
4. Dari panel **Navigator → Expert Advisors**, **seret GoldScalper ke chart**.
   Di dialog yang muncul, tab *Common*: centang **Allow Algo Trading** → OK.
5. Pastikan tombol **Algo Trading** di toolbar atas **menyala hijau**.
   Panel status EA muncul di pojok kiri atas chart — selesai, bot jalan.

> EA mengikuti simbol chart, jadi otomatis cocok untuk `XAUUSD`, `XAUUSDm`,
> `XAUUSDz` sesuai tipe akun Exness kamu.

## Parameter (klik kanan chart → Expert List → GoldScalper → Inputs)

| Input | Default | Arti |
|---|---|---|
| Timeframe sinyal | (chart) | M1 atau M5 |
| Risk per trade | 1.0 % | % equity yang dirisikokan per posisi |
| Maks posisi | 2 | posisi terbuka milik EA |
| Maks spread | $0.40 | skip entry saat spread lebar |
| SL / TP | 1.5 / 1.1 ×ATR | adaptif volatilitas |
| Break-even | 0.5 ×ATR | SL digeser ke entry + buffer |
| Trailing | mulai 0.8, jarak 0.8 ×ATR | mengunci profit |
| Cooldown | 45 dtk | jeda antar entry |
| Stop rugi harian | 5 % | EA berhenti sendiri sampai besok |
| Target profit harian | 0 (off) | berhenti setelah target tercapai |

## Backtest Dulu (disarankan!)

Di MT5 tekan **Ctrl+R** (Strategy Tester) → Expert: `GoldScalper`,
Symbol: `XAUUSD`, Period: `M1`, Model: *Every tick based on real ticks* →
Start. Gratis dan memakai data historis Exness — uji dulu sebelum uang asli.

## Supaya Jalan 24/5

EA hanya trading selama terminal MT5-nya hidup. Pilihan:

- **VPS gratis dari Exness** — tersedia untuk akun yang memenuhi syarat
  (cek menu *VPS* di area klien Exness).
- **MQL5 VPS** — tombol kanan-bawah terminal MT5, ~$10/bln, sinkron 1 klik.
- **VPS Windows sendiri** — jalankan MT5 di dalamnya.
- PC sendiri yang menyala selama jam pasar juga cukup untuk mencoba.

## ⚠️ Risiko

Sama seperti versi web: leverage tinggi di gold dapat menghabiskan modal.
Uji di **akun demo Exness** dulu, mulai dengan risk kecil (0.5–1%), dan
biarkan proteksi rugi harian tetap aktif.
