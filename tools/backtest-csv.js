// ============================================================
// Backtest on real XAU/USD broker CSV data (MT-style, tab-sep:
// datetime, open, high, low, close, volume).
// Usage: node tools/backtest-csv.js <M15.csv> <H1.csv> <H4.csv>
// Same trade model as tools/backtest.js: 1 SL + 3 TPs,
// SL -> breakeven after TP1, conservative same-candle fills
// (SL first), 3 pips spread, one trade at a time.
// ============================================================
const fs = require('fs');
const vm = require('vm');
const ctx = { console, Date, Math, JSON, Map };
vm.createContext(ctx);
const BBEngine = vm.runInContext(fs.readFileSync(__dirname + '/../js/engine.js', 'utf8') + ';BBEngine', ctx);

const PIP = 0.10;
const toPips = d => d / PIP;
const SPREAD_PIPS = 3;

function loadCSV(path) {
  const out = [];
  for (const line of fs.readFileSync(path, 'utf8').split('\n')) {
    const p = line.trim().split('\t');
    if (p.length < 5) continue;
    const t = Date.parse(p[0].replace(' ', 'T') + 'Z');
    if (isNaN(t)) continue;
    out.push({ t, o: +p[1], h: +p[2], l: +p[3], c: +p[4] });
  }
  return out;
}

const [m15Path, h1Path, h4Path] = process.argv.slice(2);
const m15All = loadCSV(m15Path);
const h1All = loadCSV(h1Path);
const h4All = loadCSV(h4Path);
console.log(`M15: ${m15All.length} (${new Date(m15All[0].t).toISOString().slice(0,10)} → ${new Date(m15All.at(-1).t).toISOString().slice(0,10)})`);
console.log(`H1: ${h1All.length}  H4: ${h4All.length}`);

const trades = [];
let open = null;
let lastEntryKey = null, lastEntryTime = 0, lastLossTime = 0;
let h1Idx = 0, h4Idx = 0;
const WARMUP = 420;
const t0 = Date.now();

for (let i = WARMUP; i < m15All.length - 1; i++) {
  const T = m15All[i].t;
  const last = m15All[i];

  if (i % 10000 === 0) console.log(`  ...${i}/${m15All.length} (${((Date.now()-t0)/1000).toFixed(0)}s, ${trades.length} trades)`);

  // ---- manage open trade ----
  if (open) {
    const c = last;
    const s = open.dir === 'buy' ? 1 : -1;
    const hitSL = s === 1 ? c.l <= open.sl : c.h >= open.sl;
    const hitTP = lvl => (s === 1 ? c.h >= lvl : c.l <= lvl);
    if (hitSL) {
      open.result = open.stage === 0 ? 'SL' : 'TP' + open.stage + '+BE';
      if (open.result === 'SL') lastLossTime = last.t;
      open.exitT = c.t; trades.push(open); open = null;
    } else {
      if (open.stage === 0 && hitTP(open.tps[0])) { open.stage = 1; open.sl = open.entry; }
      if (open && open.stage === 1 && hitTP(open.tps[1])) open.stage = 2;
      if (open && open.stage === 2 && hitTP(open.tps[2])) {
        open.result = 'TP3'; open.exitT = c.t; trades.push(open); open = null;
      }
      if (open && c.t - open.t > 5 * 24 * 3600e3) {
        open.result = 'TIMEOUT' + (open.stage ? '@TP' + open.stage : '');
        open.exitPips = toPips((c.c - open.entry) * s);
        open.exitT = c.t; trades.push(open); open = null;
      }
    }
    if (open) continue;
  }

  // advance H1/H4 pointers to candles fully closed before T
  while (h1Idx < h1All.length && h1All[h1Idx].t + 3600000 <= T) h1Idx++;
  while (h4Idx < h4All.length && h4All[h4Idx].t + 14400000 <= T) h4Idx++;
  if (h1Idx < 80 || h4Idx < 40) continue;

  // quick market-hours pre-check to skip dead time cheaply
  const d = new Date(T + 900000), day = d.getUTCDay(), hr = d.getUTCHours();
  if (day === 6 || (day === 5 && hr >= 21) || (day === 0 && hr < 22)) continue;

  const stub = { t: last.t + 900000, o: last.c, h: last.c, l: last.c, c: last.c };
  const m15 = m15All.slice(Math.max(0, i - 419), i + 1).concat([stub]);
  const h1 = h1All.slice(Math.max(0, h1Idx - 500), h1Idx);
  const h4 = h4All.slice(Math.max(0, h4Idx - 200), h4Idx);

  let res;
  try {
    res = BBEngine.run({ m15, h1, h4, spot: { price: last.c }, now: T });
  } catch (e) { continue; }

  if (T - lastLossTime < 4 * 3600e3) continue;
  if (res.signal) {
    const s = res.signal;
    const key = s.kind + s.dir + Math.round(s.entry / 2) * 2;
    if (key === lastEntryKey && T - lastEntryTime < 6 * 3600e3) continue;
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
}

function report(label, set) {
  const m = set.length;
  if (!m) return;
  const w = set.filter(t => t.result.startsWith('TP') || /@TP/.test(t.result)).length;
  const tp3 = set.filter(t => t.result === 'TP3').length;
  const sl = set.filter(t => t.result === 'SL').length;
  const net = set.reduce((s, t) => s + t.netPips, 0);
  const days = (set.at(-1).t - set[0].t) / 86400e3 * (5 / 7);
  console.log(`${label.padEnd(22)} trades=${String(m).padStart(4)}  TP1-acc=${(w/m*100).toFixed(1)}%  TP3=${(tp3/m*100).toFixed(1)}%  SL=${(sl/m*100).toFixed(1)}%  net=${net.toFixed(0)}p  (~${(net/Math.max(days,1)).toFixed(1)} p/day)`);
}

console.log('\n========== BACKTEST ON REAL XAU/USD DATA ==========');
report('OVERALL', done);
report('  MSNR', done.filter(t => t.kind === 'MSNR'));
report('  Price Action', done.filter(t => t.kind === 'Price Action'));
console.log('---- by year ----');
const years = [...new Set(done.map(t => new Date(t.t).getUTCFullYear()))];
for (const y of years) report('  ' + y, done.filter(t => new Date(t.t).getUTCFullYear() === y));
