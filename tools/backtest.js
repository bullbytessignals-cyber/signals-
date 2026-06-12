// ============================================================
// Backtest: replay the BBEngine signal logic candle-by-candle
// over the last ~60 days of real gold-market M15 data (GC=F).
// Trade model = exactly what the site states:
//   1 SL + 3 TPs, partials at TP1 then SL -> breakeven,
//   conservative fills (if SL and TP touch in the same candle,
//   count the SL first), 3 pips spread cost per trade.
// ============================================================
const fs = require('fs');
const vm = require('vm');
const ctx = { fetch, AbortController, console, setTimeout, clearTimeout, Date, Math, JSON, Map };
vm.createContext(ctx);
const BBData = vm.runInContext(fs.readFileSync(__dirname + '/../js/data.js', 'utf8') + ';BBData', ctx);
const BBEngine = vm.runInContext(fs.readFileSync(__dirname + '/../js/engine.js', 'utf8') + ';BBEngine', ctx);

const PIP = 0.10;
const toPips = d => d / PIP;
const SPREAD_PIPS = 3; // ~30 cents round-trip cost

async function yahoo(interval, range) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/GC%3DF?interval=${interval}&range=${range}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const d = await r.json();
  const res = d.chart.result[0];
  const q = res.indicators.quote[0];
  const out = [];
  for (let i = 0; i < res.timestamp.length; i++) {
    if (q.open[i] == null || q.close[i] == null) continue;
    out.push({ t: res.timestamp[i] * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i] });
  }
  return out;
}

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

(async () => {
  const [m15All, h1All] = await Promise.all([yahoo('15m', '60d'), yahoo('60m', '6mo')]);
  const h4All = toH4(h1All);
  console.log(`Data: ${m15All.length} M15 candles  (${new Date(m15All[0].t).toISOString().slice(0,10)} → ${new Date(m15All.at(-1).t).toISOString().slice(0,10)})`);

  const trades = [];
  let open = null;
  let lastEntryKey = null, lastEntryTime = 0, lastLossTime = 0;

  const WARMUP = 300; // need history for swings/levels

  for (let i = WARMUP; i < m15All.length - 1; i++) {
    const T = m15All[i].t;
    const closed = m15All.slice(0, i + 1);          // candle i just closed
    const last = closed[closed.length - 1];

    // ---- manage open trade on this candle ----
    if (open) {
      const c = last;
      const s = open.dir === 'buy' ? 1 : -1;
      const hitSL = s === 1 ? c.l <= open.sl : c.h >= open.sl;
      const hitTP = lvl => (s === 1 ? c.h >= lvl : c.l <= lvl);
      // conservative: SL checked first within the candle
      if (hitSL) {
        if (open.stage === 0) { open.result = 'SL'; lastLossTime = c.t; }
        else { open.result = 'TP' + open.stage + '+BE'; }
        open.exitT = c.t; trades.push(open); open = null;
      } else {
        if (open.stage === 0 && hitTP(open.tps[0])) { open.stage = 1; open.sl = open.entry; } // BE
        if (open && open.stage === 1 && hitTP(open.tps[1])) open.stage = 2;
        if (open && open.stage === 2 && hitTP(open.tps[2])) {
          open.result = 'TP3'; open.exitT = c.t; trades.push(open); open = null;
        }
        if (open && c.t - open.t > 5 * 24 * 3600e3) { // 5-day timeout
          open.result = 'TIMEOUT' + (open.stage ? '@TP' + open.stage : '');
          open.exitPips = toPips((c.c - open.entry) * s);
          open.exitT = c.t; trades.push(open); open = null;
        }
      }
      if (open) continue; // one trade at a time
    }

    // ---- ask the engine for a signal at this moment ----
    // stub forming candle so the engine's "last closed" = the real last closed
    const stub = { t: last.t + 900000, o: last.c, h: last.c, l: last.c, c: last.c };
    const m15 = [...closed.slice(-420), stub];
    const h1 = h1All.filter(c => c.t + 3600000 <= T).slice(-500);
    const h4 = h4All.filter(c => c.t + 14400000 <= T).slice(-200);
    if (h1.length < 60 || h4.length < 30) continue;

    let res;
    try {
      res = BBEngine.run({ m15, h1, h4, spot: { price: last.c }, now: T });
    } catch (e) { continue; }

    if (T - lastLossTime < 4 * 3600e3) continue;
  if (res.signal) {
      const s = res.signal;
      const key = s.kind + s.dir + Math.round(s.entry / 2) * 2;
      if (key === lastEntryKey && T - lastEntryTime < 6 * 3600e3) continue; // dedupe like the live app
      lastEntryKey = key; lastEntryTime = T;
      open = {
        t: T, kind: s.kind, dir: s.dir, entry: s.entry, sl: s.sl, tps: s.tps.slice(),
        slPips: s.slPips, tp1Pips: s.tp1Pips, tp2Pips: s.tp2Pips, tp3Pips: s.tp3Pips,
        grade: s.grade, stage: 0,
      };
    }
  }
  if (open) { open.result = 'OPEN'; trades.push(open); }

  // ---- stats ----
  const done = trades.filter(t => t.result !== 'OPEN');
  const n = done.length;
  const cnt = p => done.filter(t => p(t)).length;
  const tp1plus = cnt(t => t.result.startsWith('TP') || /TIMEOUT@TP/.test(t.result));
  const tp2plus = cnt(t => ['TP2+BE', 'TP3', 'TIMEOUT@TP2'].includes(t.result));
  const tp3 = cnt(t => t.result === 'TP3');
  const sl = cnt(t => t.result === 'SL');
  const timeoutFlat = cnt(t => t.result.startsWith('TIMEOUT') && !/@TP/.test(t.result));

  // net pips with the stated plan: 50% out at TP1, 25% at TP2, 25% at TP3, BE after TP1
  let netPips = 0;
  for (const t of done) {
    let p = 0;
    if (t.result === 'SL') p = -t.slPips;
    else if (t.result === 'TP1+BE') p = 0.5 * t.tp1Pips;
    else if (t.result === 'TP2+BE') p = 0.5 * t.tp1Pips + 0.25 * t.tp2Pips;
    else if (t.result === 'TP3') p = 0.5 * t.tp1Pips + 0.25 * t.tp2Pips + 0.25 * t.tp3Pips;
    else if (t.result.startsWith('TIMEOUT')) {
      if (t.result.includes('@TP2')) p = 0.5 * t.tp1Pips + 0.25 * t.tp2Pips + 0.25 * Math.max(0, t.exitPips ?? 0);
      else if (t.result.includes('@TP1')) p = 0.5 * t.tp1Pips + 0.5 * Math.max(0, t.exitPips ?? 0);
      else p = (t.exitPips ?? 0);
    }
    t.netPips = p - SPREAD_PIPS;
    netPips += t.netPips;
  }
  const avgR = done.length ? done.reduce((s, t) => s + t.netPips / t.slPips, 0) / done.length : 0;

  console.log('\n================ BACKTEST RESULTS (last ~60 days) ================');
  console.log(`Signals taken: ${trades.length}  (closed: ${n})`);
  console.log(`By type: MSNR=${trades.filter(t=>t.kind==='MSNR').length}  PriceAction=${trades.filter(t=>t.kind==='Price Action').length}`);
  console.log(`TP1 hit before SL (accuracy): ${tp1plus}/${n} = ${(tp1plus/n*100).toFixed(1)}%`);
  console.log(`Reached TP2: ${tp2plus}/${n} = ${(tp2plus/n*100).toFixed(1)}%   Reached TP3: ${tp3}/${n} = ${(tp3/n*100).toFixed(1)}%`);
  console.log(`Full SL losses: ${sl}/${n} = ${(sl/n*100).toFixed(1)}%   Flat timeouts: ${timeoutFlat}`);
  console.log(`Net result (50/25/25 scale-out, BE after TP1, ${SPREAD_PIPS}p spread): ${netPips.toFixed(0)} pips = $${(netPips*0.1).toFixed(0)} per lot`);
  console.log(`Average R per trade: ${avgR.toFixed(2)}R`);

  // per-kind accuracy
  for (const kind of ['MSNR', 'Price Action']) {
    const k = done.filter(t => t.kind === kind);
    if (!k.length) continue;
    const w = k.filter(t => t.result.startsWith('TP') || /@TP/.test(t.result)).length;
    const net = k.reduce((s, t) => s + t.netPips, 0);
    console.log(`  ${kind}: ${k.length} trades, TP1-accuracy ${(w/k.length*100).toFixed(1)}%, net ${net.toFixed(0)} pips`);
  }

  console.log('\nTrade log:');
  for (const t of trades) {
    console.log(`  ${new Date(t.t).toISOString().slice(0,16)}  ${t.kind.padEnd(12)} ${t.dir.toUpperCase().padEnd(4)} @${t.entry.toFixed(1)}  SL ${t.slPips}p  ${String(t.result).padEnd(10)} ${t.netPips!=null? (t.netPips>=0?'+':'')+t.netPips.toFixed(0)+'p':''}`);
  }
})().catch(e => { console.error('BACKTEST FAILED:', e); process.exit(1); });
