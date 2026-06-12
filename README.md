# BullBytes Gold Signals 🥇

Professional real-time **XAU/USD (spot gold)** signal platform powered by
**MSNR (Malaysian Support & Resistance)** and **advanced price action**.

**Live demo (after enabling GitHub Pages):** `https://bullbytessignals-cyber.github.io/signals-/`

## What it does

- **Live spot XAU/USD price** (gold-api.com, Swissquote fallback) — refreshed every 15 s
- **Real gold-market candles** (COMEX GC=F via Yahoo Finance), auto-calibrated to spot
  XAU/USD so every level/entry/SL/TP shown is true spot gold — re-analysed every 60 s
- **Live TradingView chart** — OANDA:XAUUSD (FX gold feed)
- **Signal engine** running the combined model:
  1. H4 structure bias (HH/HL · BOS/CHoCH)
  2. Fresh **body-based** MSNR levels (Gap SNR, SNR flips, A/V shapes, fresh vs tested)
  3. Liquidity sweep of equal highs/lows
  4. M15 rejection confirmation (engulfing / pin bar)
  5. Session timing (Asia range → London fake → New York true move)
- **Every signal: 1 SL + 3 TPs** (SL range 20–100 pips, never higher)
  - MSNR setups: SL normally 20–40 pips (volatility floor may widen, capped at 100) · TP1 = 50 pips · TP2 = 2R · TP3 = 150–200 pips (live-volatility scaled)
  - Price-action setups: SL normally 50–80 pips · TP1 = 1:1 · TP2 = 2R · TP3 = 150–200+ pips

## Backtest

Two backtest tools replay the engine candle-by-candle (SL → breakeven after TP1,
3-pip spread, 4h post-loss cooldown, one trade at a time):

- `node tools/backtest.js` — fetches the last ~60 days of market data automatically
- `node tools/backtest-csv.js <M15.csv> <H1.csv> <H4.csv>` — runs on your own
  MT-style XAU/USD history exports for long-range testing

Honest results on real spot XAU/USD broker data with M5-accurate fills:
**2026 YTD: 52.7% of signals hit TP1 before SL, 23% ran to TP3, net ≈ +1546 pips.**
2025 (the parabolic trend year) was net negative — performance is regime-dependent.
Past performance does not guarantee future results; signals are educational only.

The full strategy methodology is documented on the site at [`guide.html`](guide.html).
- Setup checklist with A+/A/B grading, MSNR levels table, market-structure dashboard,
  trading-session tracker, gold position-size calculator, and local signal history with win-rate stats

## Run it

Pure static site — no build step, no server, no API keys.

```bash
# any static server works:
npx serve .
# or just open index.html in a browser
```

### Deploy free on GitHub Pages

Repo **Settings → Pages → Source: Deploy from a branch → main / (root)** → Save.
The site goes live at the URL above in ~1 minute.

## Stack

Vanilla HTML/CSS/JS · TradingView embed · gold-api.com + Yahoo Finance (GC=F) + Swissquote ·
all analysis computed client-side in `js/engine.js`.

## Disclaimer

Trading gold carries a high level of risk and can result in the loss of all your capital.
Everything on this site is generated automatically from market data for **educational
purposes only** and is **not financial advice**. Never trade money you cannot afford to lose.
