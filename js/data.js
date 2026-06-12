/* =====================================================
   BullBytes Gold — data layer
   Live spot XAU/USD + real gold-market candles.
   Candle priority:
     1. Yahoo Finance GC=F (COMEX gold futures — the real
        gold market) fetched direct or via CORS proxy,
        then CALIBRATED to live XAU/USD spot so every
        price shown is true spot gold.
     2. OKX PAXG/USDT (last-resort backup only), also
        calibrated to live XAU/USD spot.
   Spot priority: gold-api.com → Swissquote public quotes.
   ===================================================== */

const BBData = (() => {

  const PROXIES = [
    u => u, // direct (works in some environments)
    u => 'https://corsproxy.io/?url=' + encodeURIComponent(u),
    u => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u),
  ];

  async function fetchJSON(url, timeoutMs = 12000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { signal: ctrl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally {
      clearTimeout(t);
    }
  }

  async function fetchViaProxies(url) {
    let lastErr;
    for (const wrap of PROXIES) {
      try { return await fetchJSON(wrap(url)); }
      catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('all proxies failed');
  }

  /* ---------- live spot XAU/USD ---------- */
  async function fetchSpot() {
    try {
      const d = await fetchJSON('https://api.gold-api.com/price/XAU');
      if (d && d.price) return { price: +d.price, ts: Date.parse(d.updatedAt) || Date.now(), source: 'gold-api.com (spot XAU/USD)' };
      throw new Error('bad payload');
    } catch (e) {
      const d = await fetchViaProxies('https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD');
      const p = d[0].spreadProfilePrices[0];
      return { price: (p.bid + p.ask) / 2, ts: Date.now(), source: 'Swissquote (spot XAU/USD)' };
    }
  }

  /* ---------- candles ---------- */
  // Normalised candle: {t, o, h, l, c}

  function parseYahoo(d) {
    const r = d.chart && d.chart.result && d.chart.result[0];
    if (!r || !r.timestamp) throw new Error('yahoo: no data');
    const q = r.indicators.quote[0];
    const out = [];
    for (let i = 0; i < r.timestamp.length; i++) {
      if (q.open[i] == null || q.close[i] == null) continue;
      out.push({ t: r.timestamp[i] * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i] });
    }
    if (out.length < 30) throw new Error('yahoo: too few candles');
    return out;
  }

  async function yahooCandles(interval, range) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/GC%3DF?interval=${interval}&range=${range}`;
    return parseYahoo(await fetchViaProxies(url));
  }

  function parseOKX(d) {
    if (!d.data || !d.data.length) throw new Error('okx: no data');
    return d.data.map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4] })).reverse();
  }

  async function okxCandles(bar) {
    const url = `https://www.okx.com/api/v5/market/candles?instId=PAXG-USDT&bar=${bar}&limit=300`;
    return parseOKX(await fetchJSON(url));
  }

  // Aggregate hourly candles into 4h blocks aligned to epoch.
  function toH4(h1) {
    const buckets = new Map();
    for (const c of h1) {
      const key = Math.floor(c.t / 14400000) * 14400000;
      let b = buckets.get(key);
      if (!b) { b = { t: key, o: c.o, h: c.h, l: c.l, c: c.c }; buckets.set(key, b); }
      else { b.h = Math.max(b.h, c.h); b.l = Math.min(b.l, c.l); b.c = c.c; }
    }
    return [...buckets.values()].sort((a, b) => a.t - b.t);
  }

  function calibrate(candles, offset) {
    if (!offset) return candles;
    return candles.map(c => ({ t: c.t, o: c.o + offset, h: c.h + offset, l: c.l + offset, c: c.c + offset }));
  }

  /**
   * Fetch all timeframes and calibrate them to live spot so every
   * level/entry/SL/TP shown is in true XAU/USD spot terms.
   * Returns { m15, h1, h4, spot, source }
   */
  async function fetchAll() {
    const spot = await fetchSpot();
    let m15, h1, source;
    try {
      [m15, h1] = await Promise.all([
        yahooCandles('15m', '5d'),
        yahooCandles('60m', '1mo'),
      ]);
      source = 'COMEX gold (GC=F) calibrated to spot XAU/USD';
    } catch (e) {
      [m15, h1] = await Promise.all([okxCandles('15m'), okxCandles('1H')]);
      source = 'backup feed calibrated to spot XAU/USD';
    }
    const offset = spot.price - m15[m15.length - 1].c;
    m15 = calibrate(m15, offset);
    h1 = calibrate(h1, offset);
    const h4 = toH4(h1);
    return { m15, h1, h4, spot, source, offset };
  }

  /** M5 candles (for scalp strategies), calibrated with the same offset. */
  async function fetchM5(offset) {
    let m5;
    try { m5 = await yahooCandles('5m', '5d'); }
    catch (e) { m5 = await okxCandles('5m'); }
    return calibrate(m5, offset || 0);
  }

  return { fetchAll, fetchSpot, fetchM5 };
})();
