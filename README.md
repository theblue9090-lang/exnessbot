# WebTrader 5 — Platform Trading XAU/USD dengan Bot Scalping Otomatis

Website trading bergaya **MetaTrader 5** (dark theme) dengan:

- 📈 Chart candlestick XAU/USD realtime + overlay EMA 9/21/50, crosshair, garis posisi/SL/TP
- 👀 Market Watch, Navigator, panel Terminal (Trade / History / Journal) ala MT5
- ⚡ One-click trading (BUY/SELL di harga bid/ask)
- 🤖 **Bot GoldScalper** — scalping otomatis XAU/USD di timeframe **M1/M5**, langsung
  mengeksekusi order **tanpa konfirmasi** begitu di-start
- 🔐 **Login broker Exness** (akun MT5) melalui MetaApi, plus **mode Demo**
  (simulator harga + paper trading, saldo virtual $10.000)

---

## Cara Menjalankan

```bash
npm install          # express + ws + metaapi.cloud-sdk (koneksi live Exness)
npm start            # server jalan di http://localhost:3000
```

Buka `http://localhost:3000`. Tanpa konfigurasi apa pun aplikasi berjalan dalam
**mode Demo**; untuk trading **LIVE** ikuti salah satu dari dua cara di bawah.

## Dua Cara Trading Live

| | Web + MetaApi | EA MQL5 (folder `mql5/`) |
|---|---|---|
| Kontrol | dari browser mana pun | dari terminal MT5 |
| Biaya jembatan | MetaApi berbayar (per jam deploy) | **gratis** |
| Butuh | hosting Node + saldo MetaApi | terminal MT5 hidup (PC/VPS/VPS gratis Exness) |
| Strategi | GoldScalper | GoldScalper (identik) |

Kalau tidak mau berlangganan MetaApi, pakai **[GoldScalper EA](mql5/README.md)** —
strategi yang sama berjalan langsung di MetaTrader 5 Exness tanpa biaya jembatan.

## Trading LIVE di Exness

Exness **tidak memiliki API web publik** — akun Exness adalah akun MetaTrader 5.
Jembatan standar untuk mengakses akun MT5 dari aplikasi web adalah
[MetaApi](https://metaapi.cloud) (cloud API untuk MT4/MT5). Daftar gratis di
[app.metaapi.cloud](https://app.metaapi.cloud) dan buat **token API** (sekali saja).

### Cara 1 — Login dari website

Klik **Login Broker → Exness (MT5)** dan isi:

- **Nomor akun MT5** (login Exness kamu)
- **Password trading** (bukan password investor)
- **Server** — misal `Exness-MT5Trial7` (demo) atau `Exness-MT5Real8`
  (terlihat di aplikasi/email Exness)
- **Token MetaApi** (boleh kosong jika sudah diisi di `.env`)

Jika akun Exness kamu sudah pernah terdaftar di MetaApi, form login akan
menampilkan daftarnya — cukup klik untuk langsung terhubung, tanpa password.

### Cara 2 — Auto-login LIVE saat server start (.env)

```bash
cp .env.example .env   # lalu isi kredensialnya
npm start
```

Isi `.env` minimal (jika akun **sudah terdaftar** di dashboard MetaApi — server
mencarinya otomatis):

```ini
METAAPI_TOKEN=token-metaapi-kamu
AUTO_START_BOT=1   # bot langsung trading otomatis begitu tersambung
```

Atau lengkap (jika akun **belum terdaftar** — server mendaftarkannya otomatis):

```ini
METAAPI_TOKEN=token-metaapi-kamu
EXNESS_LOGIN=12345678
EXNESS_PASSWORD=password-trading
EXNESS_SERVER=Exness-MT5Real8
AUTO_START_BOT=1
```

Server akan langsung tersambung LIVE saat dinyalakan; dengan `AUTO_START_BOT=1`
bot GoldScalper ikut menyala otomatis — cocok untuk dijalankan 24/5 di VPS.
Jika auto-login gagal (token salah, server down), aplikasi tetap hidup dalam
mode Demo dan alasannya tercatat di tab **Journal**.

Koneksi pertama butuh 1–3 menit (akun di-deploy di cloud MetaApi). Setelah
tersambung, saldo/posisi asli akun Exness tampil (badge **EXNESS LIVE**) dan
semua order — manual maupun bot — dieksekusi ke akun tersebut. Simbol gold
terdeteksi otomatis (`XAUUSD`, `XAUUSDm`, `XAUUSDc`, dll. sesuai tipe akun).

> 💡 **Sangat disarankan** menguji bot di akun **demo Exness** (server MT5Trial)
> dulu sebelum akun real.

## Deploy ke Internet (jalankan bot lewat web)

Supaya bot bisa dikendalikan dari browser mana pun (HP/laptop) tanpa
menjalankan Node di komputer sendiri, deploy repo ini ke hosting Node.js.
Sudah disiapkan `Dockerfile` (jalan di hosting mana pun) dan `render.yaml`
(blueprint Render).

### Render.com (paling mudah)

1. Fork/push repo ini ke GitHub kamu (branch mana pun).
2. Buka [dashboard.render.com](https://dashboard.render.com) → **New → Blueprint**
   → pilih repo ini. Render membaca `render.yaml` otomatis.
3. Isi environment variables saat diminta:
   - `APP_PASSWORD` — **wajib**: password akses website (tanpa ini siapa pun
     yang tahu URL bisa mengendalikan akunmu!)
   - `METAAPI_TOKEN` — token MetaApi kamu
   - (opsional) `METAAPI_ACCOUNT_ID` atau `EXNESS_LOGIN/PASSWORD/SERVER`
4. Deploy. Setelah selesai kamu dapat URL `https://exness-webtrader-xxxx.onrender.com`
   — buka dari mana saja, masukkan `APP_PASSWORD`, dan dashboard MT5-nya tampil.
   Dengan `AUTO_START_BOT=1` bot langsung trading begitu service tersambung
   ke Exness.

> ⚠️ Plan **free** Render tidur setelah ±15 menit tanpa pengunjung — bot ikut
> berhenti, dan bangun lagi (plus auto-login + auto-start bot) saat URL dibuka.
> Untuk bot yang benar-benar jalan 24/5 gunakan plan **Starter** ($7/bln) atau
> VPS murah + `docker run`.

### Railway / Fly.io / VPS (Docker)

```bash
docker build -t exnessbot .
docker run -d -p 3000:3000 \
  -e APP_PASSWORD=passwordku \
  -e METAAPI_TOKEN=token-metaapi \
  -e AUTO_START_BOT=1 \
  --restart unless-stopped exnessbot
```

### Keamanan saat online

- `APP_PASSWORD` melindungi seluruh halaman, REST API, dan WebSocket
  (cookie HttpOnly, perbandingan timing-safe).
- Pakai selalu URL **https** (Render/Railway sudah otomatis).
- Jangan pernah commit `.env` — file ini sudah di-`.gitignore`.

## Bot GoldScalper — Strategi

Scalping berbasis konfluensi, evaluasi di setiap **candle close** (M1 atau M5):

| Komponen | Aturan |
|---|---|
| Trend | EMA9 vs EMA21, harga relatif EMA50 |
| Trigger | Fresh crossover EMA9/21 (≤3 candle) **atau** pullback ke EMA9 yang ditutup searah trend |
| Momentum | RSI(14) 50–72 untuk BUY / 28–50 untuk SELL, body candle ≥ 25% ATR |
| SL / TP | 1.5 × ATR(14) / 1.5 × ATR(14) — jarak sama (risk:reward 1:1), adaptif volatilitas |
| Break-even | SL digeser ke entry (+buffer) setelah profit 0.5 × ATR |
| Trailing stop | Mengikuti harga sejauh 0.8 × ATR setelah profit 0.8 × ATR |
| Lot sizing | Otomatis dari **risk % per trade** (default 1% equity) terhadap jarak SL |
| Filter | Spread maks $0.40, maks 2 posisi, cooldown 45 detik antar entry |
| Proteksi | Auto-stop jika rugi harian ≥ 5% equity (bisa diubah), target profit harian opsional |

Semua parameter bisa diubah dari tombol **⚙** di toolbar. Aktivitas bot
(sinyal, eksekusi, trailing, proteksi) tercatat di tab **Journal** — termasuk
**alasan bila belum entry** (spread terlalu lebar, warmup candle, batas posisi,
margin), supaya mudah tahu kenapa bot diam.

### Mode entry (⚙ → Mode entry)

| Mode | Perilaku |
|---|---|
| **Scalping M1 winrate tinggi** ⭐ (default) | Mean-reversion: fade harga ekstrem (keluar Bollinger 1.8σ + RSI 38/62) menuju mean. TP kecil (di mean) = sering tercapai; SL lebih lebar |
| **Normal** | Konfluensi ketat (EMA+RSI+ATR+body) — paling selektif |
| **Agresif M1** | Filter longgar (EMA5/EMA13 + candle) — entry ~3× lebih sering |
| **Pembukaan candle** | Paling agresif: entry mengikuti arah candle M1 terakhir **hampir setiap menit** |

> ⚠️ **Winrate tinggi ≠ profit terjamin.** Mean-reversion menang sering (TP kecil)
> tapi risk:reward negatif: sesekali harga menembus terus dan satu kerugian (SL
> lebih lebar) bisa menghapus beberapa kemenangan kecil. Break-even ratchet
> membantu, tapi tetap **uji di demo** dan pahami trade-off-nya.

> ⚠️ "Pembukaan candle" praktis mengikuti candle terakhir tanpa menyaring
> kualitas sinyal — sangat sering entry, tapi mudah rugi ke spread bila winrate
> tidak di atas ~55%. **Uji di akun demo dulu.**

## Struktur Proyek

```
server/
  index.js      # HTTP + WebSocket server, REST API
  bot.js        # bot scalping GoldScalper
  simulator.js  # simulator pasar XAU/USD + paper broker (mode demo)
  exness.js     # adapter akun Exness MT5 via MetaApi
  indicators.js # EMA, RSI, ATR
public/
  index.html    # UI ala MetaTrader 5
  css/style.css
  js/app.js     # chart canvas, websocket client, kontrol bot
```

## ⚠️ Disclaimer Risiko

Trading emas (XAU/USD) dengan leverage berisiko tinggi dan dapat menghabiskan
seluruh modal. Bot ini adalah alat bantu — **bukan jaminan profit**. Kinerja di
simulator/backtest tidak menjamin hasil di pasar nyata. Gunakan akun demo
terlebih dahulu, pahami parameternya, dan trading dengan dana yang siap Anda
tanggung risikonya. Anda bertanggung jawab penuh atas semua order yang
dieksekusi bot di akun Anda.
