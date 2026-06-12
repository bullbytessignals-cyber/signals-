/* =====================================================
   BullBytes Gold — signal engine
   Implements the combined model:
     H4 structure bias → fresh MSNR body level →
     liquidity sweep → M15 rejection/CHoCH confirmation.
   Signal output: 1 SL + 3 TPs. SL range 20–100 pips max.
     MSNR trade:         SL normally 20–40 pips (volatility
                         floor may widen it, capped at 100),
                         TP1 = 50 pips (or 1:1 if SL > 40),
                         TP2 = 2R min 100, TP3 = 150–200+
                         (scaled by live volatility).
     Price action trade: SL normally 50–80 pips, TP1 = 1:1,
                         TP2 = 2R, TP3 = 150–200+ pips.
   Gold pip = $0.10.
   ===================================================== */

const BBEngine = (() => {

  const PIP = 0.10;
  const toPips = d => d / PIP;
  const fromPips = p => p * PIP;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /* ---------- indicators ---------- */

  function atr(candles, n = 14) {
    if (candles.length < n + 1) return 0;
    let sum = 0;
    for (let i = candles.length - n; i < candles.length; i++) {
      const tr = Math.max(
        candles[i].h - candles[i].l,
        Math.abs(candles[i].h - candles[i - 1].c),
        Math.abs(candles[i].l - candles[i - 1].c)
      );
      sum += tr;
    }
    return sum / n;
  }

  // Fractal swing points (wick extremes — used for structure & sweeps).
  function findSwings(candles, k = 2) {
    const highs = [], lows = [];
    for (let i = k; i < candles.length - k; i++) {
      let isH = true, isL = true;
      for (let j = 1; j <= k; j++) {
        if (candles[i].h < candles[i - j].h || candles[i].h < candles[i + j].h) isH = false;
        if (candles[i].l > candles[i - j].l || candles[i].l > candles[i + j].l) isL = false;
      }
      if (isH) highs.push({ i, price: candles[i].h, t: candles[i].t });
      if (isL) lows.push({ i, price: candles[i].l, t: candles[i].t });
    }
    return { highs, lows };
  }

  /* ---------- market structure (HH/HL · BOS/CHoCH) ---------- */

  function analyzeStructure(candles) {
    const { highs, lows } = findSwings(candles, 2);
    if (highs.length < 2 || lows.length < 2) return { trend: 'ranging', event: null, highs, lows };

    const [hPrev, hLast] = highs.slice(-2);
    const [lPrev, lLast] = lows.slice(-2);
    const close = candles[candles.length - 1].c;

    let trend = 'ranging';
    if (hLast.price > hPrev.price && lLast.price > lPrev.price) trend = 'bullish';
    else if (hLast.price < hPrev.price && lLast.price < lPrev.price) trend = 'bearish';
    else if (hLast.price > hPrev.price) trend = 'bullish';
    else if (lLast.price < lPrev.price) trend = 'bearish';

    // BOS = close beyond last swing with the trend; CHoCH = close against it.
    let event = null;
    if (trend === 'bullish') {
      if (close > hLast.price) event = 'BOS ↑';
      else if (close < lLast.price) { event = 'CHoCH ↓'; trend = 'bearish'; }
    } else if (trend === 'bearish') {
      if (close < lLast.price) event = 'BOS ↓';
      else if (close > hLast.price) { event = 'CHoCH ↑'; trend = 'bullish'; }
    }
    return { trend, event, highs, lows, lastHigh: hLast, lastLow: lLast };
  }

  /* ---------- MSNR levels (body-based) ---------- */

  const bodyHi = c => Math.max(c.o, c.c);
  const bodyLo = c => Math.min(c.o, c.c);
  const bodySize = c => Math.abs(c.c - c.o);
  const range = c => c.h - c.l;

  function rawLevels(candles, tf) {
    const out = [];
    const { highs, lows } = findSwings(candles, 2);
    const avgBody = candles.reduce((s, c) => s + bodySize(c), 0) / candles.length;

    // Swing-point body levels (+ A/V shape detection on the swing candle)
    for (const s of highs) {
      const c = candles[s.i];
      const sharp = bodySize(candles[s.i - 1]) > avgBody && bodySize(candles[s.i + 1]) > avgBody &&
                    candles[s.i - 1].c > candles[s.i - 1].o && candles[s.i + 1].c < candles[s.i + 1].o;
      out.push({ price: bodyHi(c), born: s.i, tf, kind: sharp ? 'A-shape' : 'Body SNR' });
    }
    for (const s of lows) {
      const c = candles[s.i];
      const sharp = bodySize(candles[s.i - 1]) > avgBody && bodySize(candles[s.i + 1]) > avgBody &&
                    candles[s.i - 1].c < candles[s.i - 1].o && candles[s.i + 1].c > candles[s.i + 1].o;
      out.push({ price: bodyLo(c), born: s.i, tf, kind: sharp ? 'V-shape' : 'Body SNR' });
    }

    // Gap SNR — body-to-body gaps (strongest level type)
    const gapMin = Math.max(avgBody * 0.6, 1.0);
    for (let i = 1; i < candles.length; i++) {
      const a = candles[i - 1], b = candles[i];
      if (bodyLo(b) - bodyHi(a) > gapMin)
        out.push({ price: (bodyHi(a) + bodyLo(b)) / 2, born: i, tf, kind: 'Gap SNR' });
      else if (bodyLo(a) - bodyHi(b) > gapMin)
        out.push({ price: (bodyLo(a) + bodyHi(b)) / 2, born: i, tf, kind: 'Gap SNR' });
    }
    return out;
  }

  /**
   * Build clustered MSNR levels from H4 + H1, count retests after
   * creation (fresh = untouched), detect SNR flips, score strength.
   */
  function buildLevels(h4, h1, price, atrH1) {
    const tol = Math.max(2.5, atrH1 * 0.35); // cluster / touch tolerance ($)
    const raw = [...rawLevels(h4, 'H4'), ...rawLevels(h1, 'H1')];
    raw.sort((a, b) => a.price - b.price);

    // cluster nearby raw levels
    const clusters = [];
    for (const lv of raw) {
      const last = clusters[clusters.length - 1];
      if (last && Math.abs(lv.price - last.price) <= tol) {
        last.members.push(lv);
        last.price = last.members.reduce((s, m) => s + m.price, 0) / last.members.length;
        if (lv.tf === 'H4') last.tf = 'H4';
        if (lv.kind === 'Gap SNR') last.kind = 'Gap SNR';
        else if (lv.kind !== 'Body SNR' && last.kind === 'Body SNR') last.kind = lv.kind;
      } else {
        clusters.push({ price: lv.price, tf: lv.tf, kind: lv.kind, members: [lv] });
      }
    }

    // touches + flip detection on the H1 series after the level was born
    for (const cl of clusters) {
      const bornIdx = Math.min(...cl.members.filter(m => m.tf === 'H1').map(m => m.born), h1.length);
      let touches = 0, closedAbove = false, closedBelow = false, inZone = false;
      for (let i = Math.min(bornIdx + 1, h1.length - 1); i < h1.length; i++) {
        const c = h1[i];
        const hit = bodyLo(c) <= cl.price + tol && bodyHi(c) >= cl.price - tol;
        if (hit && !inZone) { touches++; inZone = true; }
        else if (!hit) inZone = false;
        if (c.c > cl.price + tol) closedAbove = true;
        if (c.c < cl.price - tol) closedBelow = true;
      }
      cl.touches = Math.max(0, touches - 1); // first visit creates it, later visits are retests
      cl.fresh = cl.touches === 0;
      cl.flip = closedAbove && closedBelow;
      cl.role = cl.price > price ? 'resistance' : 'support';
      cl.strength = clamp(
        40 +
        (cl.fresh ? 25 : -10 * cl.touches) +
        (cl.kind === 'Gap SNR' ? 20 : 0) +
        (cl.kind === 'A-shape' || cl.kind === 'V-shape' ? 12 : 0) +
        (cl.tf === 'H4' ? 15 : 0) +
        (cl.flip ? 8 : 0) +
        (cl.members.length > 2 ? 8 : 0),
        5, 100);
    }

    return clusters
      .filter(c => Math.abs(c.price - price) < atrH1 * 12) // keep relevant ones
      .sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price));
  }

  /* ---------- liquidity sweeps (M15) ---------- */

  function detectSweep(m15) {
    const { highs, lows } = findSwings(m15.slice(0, -1), 2);
    const eqTol = 1.5; // $ — equal highs/lows tolerance
    const recent = m15.slice(-10);

    function check(swings, side) {
      for (let i = 0; i < swings.length - 1; i++) {
        for (let j = i + 1; j < swings.length; j++) {
          if (Math.abs(swings[i].price - swings[j].price) > eqTol) continue;
          const lvl = (swings[i].price + swings[j].price) / 2;
          for (const c of recent) {
            if (side === 'high' && c.h > lvl + 0.3 && c.c < lvl) return { side: 'sell', level: lvl, t: c.t };
            if (side === 'low' && c.l < lvl - 0.3 && c.c > lvl) return { side: 'buy', level: lvl, t: c.t };
          }
        }
      }
      return null;
    }
    return check(highs.slice(-8), 'high') || check(lows.slice(-8), 'low');
  }

  /* ---------- M15 confirmation candles ---------- */

  function detectConfirmation(m15, dir) {
    const c = m15[m15.length - 2]; // last CLOSED candle
    const p = m15[m15.length - 3];
    if (!c || !p) return null;
    const b = bodySize(c), r = range(c);
    if (r === 0) return null;

    if (dir === 'buy') {
      const engulf = c.c > c.o && p.c < p.o && c.c >= bodyHi(p) && c.o <= bodyLo(p);
      const lowerWick = Math.min(c.o, c.c) - c.l;
      const pin = lowerWick >= 2 * b && (c.c - c.l) / r >= 0.6;
      if (engulf) return 'bullish engulfing';
      if (pin) return 'bullish pin bar';
    } else {
      const engulf = c.c < c.o && p.c > p.o && c.c <= bodyLo(p) && c.o >= bodyHi(p);
      const upperWick = c.h - Math.max(c.o, c.c);
      const pin = upperWick >= 2 * b && (c.h - c.c) / r >= 0.6;
      if (engulf) return 'bearish engulfing';
      if (pin) return 'bearish pin bar';
    }
    return null;
  }

  /* ---------- order blocks & FVGs (H1, for price-action setups) ---------- */

  function detectOBFVG(h1, trend, price, atrH1) {
    const n = h1.length;
    // FVG: 3-candle imbalance
    for (let i = n - 3; i > n - 40 && i > 1; i--) {
      const a = h1[i - 1], b = h1[i], cc = h1[i + 1];
      if (trend === 'bullish' && cc.l > a.h && bodySize(b) > atrH1 * 0.8) {
        const zone = { lo: a.h, hi: cc.l, type: 'FVG' };
        if (price >= zone.lo - 0.5 && price <= zone.hi + 0.5) return { ...zone, dir: 'buy' };
      }
      if (trend === 'bearish' && cc.h < a.l && bodySize(b) > atrH1 * 0.8) {
        const zone = { lo: cc.h, hi: a.l, type: 'FVG' };
        if (price >= zone.lo - 0.5 && price <= zone.hi + 0.5) return { ...zone, dir: 'sell' };
      }
    }
    // Order block: last opposite candle before an impulse
    for (let i = n - 4; i > n - 40 && i > 2; i--) {
      const ob = h1[i];
      const impulse = (h1[i + 1].c - h1[i + 1].o) + (h1[i + 2].c - h1[i + 2].o);
      if (trend === 'bullish' && ob.c < ob.o && impulse > atrH1 * 1.5) {
        const zone = { lo: bodyLo(ob), hi: bodyHi(ob), type: 'Order Block' };
        if (price >= zone.lo - 0.5 && price <= zone.hi + 1.0) return { ...zone, dir: 'buy' };
      }
      if (trend === 'bearish' && ob.c > ob.o && impulse < -atrH1 * 1.5) {
        const zone = { lo: bodyLo(ob), hi: bodyHi(ob), type: 'Order Block' };
        if (price >= zone.lo - 1.0 && price <= zone.hi + 0.5) return { ...zone, dir: 'sell' };
      }
    }
    return null;
  }

  /* ---------- sessions ---------- */

  function sessionInfo(now = new Date()) {
    const h = now.getUTCHours() + now.getUTCMinutes() / 60;
    const day = now.getUTCDay();
    // Gold trades ~Sun 22:00 UTC → Fri 21:00 UTC, daily pause 21:00–22:00.
    const open =
      (day >= 1 && day <= 4) ? !(h >= 21 && h < 22) :
      day === 5 ? h < 21 :
      day === 0 ? h >= 22 : false;

    const sessions = [];
    if (h >= 23 || h < 7) sessions.push('Asia');
    if (h >= 7 && h < 16) sessions.push('London');
    if (h >= 12 && h < 21) sessions.push('New York');
    const prime = (h >= 7 && h < 10) || (h >= 12.5 && h < 17);
    const usDataHour = day >= 1 && day <= 5 && h >= 12.25 && h < 13.25;
    return { open, sessions, prime, usDataHour };
  }

  /* ---------- SL / TP model: 1 SL + 3 TPs ---------- */

  function buildTargets(kind, dir, entry, rawSlPips, atrH1pips) {
    // volatility factor 0..1 from live H1 ATR (≈100 pips calm → ≈250 pips wild)
    const vol = clamp((atrH1pips - 100) / 150, 0, 1);
    // SL hard range: 20–100 pips, never higher (both setups).
    // MSNR stops are wick-based and tight (normally 20–40), so they get a
    // volatility floor to survive noise in fast markets; price action stops
    // are zone-based and already structural (normally 50–80).
    const slPips = kind === 'MSNR'
      ? clamp(Math.max(rawSlPips, clamp(atrH1pips * 0.30, 20, 100)), 20, 100)
      : clamp(rawSlPips, 50, 80);
    // 1 SL + 3 TPs: tight stops (≤40p) take TP1 at 50 pips, otherwise TP1 = 1:1;
    // TP2 = 2R (min 100); TP3 = 150–200+ scaled by live volatility.
    const tp1 = slPips <= 40 ? 50 : Math.round(slPips);
    const tp2 = Math.max(Math.round(slPips * 2), 100);
    const tp3 = Math.max(tp2 + 40, Math.round(150 + 50 * vol));
    const s = dir === 'buy' ? 1 : -1;
    return {
      slPips: Math.round(slPips), tp1Pips: tp1, tp2Pips: tp2, tp3Pips: tp3, vol,
      sl: entry - s * fromPips(slPips),
      tps: [entry + s * fromPips(tp1), entry + s * fromPips(tp2), entry + s * fromPips(tp3)],
    };
  }

  /* ---------- main: generate signal ---------- */

  function run({ m15, h1, h4, spot, now }) {
    const price = spot.price;
    const atrH1 = atr(h1, 14);
    const atrH1pips = toPips(atrH1);
    const stH4 = analyzeStructure(h4);
    const stH1 = analyzeStructure(h1);
    const stM15 = analyzeStructure(m15);
    const levels = buildLevels(h4, h1, price, atrH1);
    const sweep = detectSweep(m15);
    const sess = sessionInfo(now ? new Date(now) : new Date());

    const bias = stH4.trend;
    const dir = bias === 'bullish' ? 'buy' : bias === 'bearish' ? 'sell' : null;

    // nearest fresh MSNR level in the direction of the bias
    const prox = Math.max(3, atrH1 * 0.6);
    const atLevel = dir && levels.find(L =>
      L.fresh &&
      Math.abs(L.price - price) <= prox &&
      ((dir === 'buy' && L.role === 'support') || (dir === 'sell' && L.role === 'resistance'))
    );

    const confirm = dir ? detectConfirmation(m15, dir) : null;
    const sweepOk = sweep && dir && sweep.side === dir;

    const checklist = {
      structure: bias !== 'ranging',
      level: !!atLevel,
      sweep: !!sweepOk,
      confirm: !!confirm,
      session: sess.prime,
      news: !sess.usDataHour,
    };
    const score = Object.values(checklist).filter(Boolean).length;
    const grade = score >= 6 ? 'A+' : score === 5 ? 'A' : score === 4 ? 'B' : score === 3 ? 'C' : '—';

    let signal = null;

    // --- MSNR setup: fresh body level + M15 confirmation (sweep = bonus) ---
    if (dir && atLevel && confirm && sess.open) {
      const rej = m15[m15.length - 2];
      const rawSl = dir === 'buy'
        ? toPips(price - rej.l) + 10   // beyond rejection wick + buffer
        : toPips(rej.h - price) + 10;
      const t = buildTargets('MSNR', dir, price, rawSl, atrH1pips);
      signal = {
        kind: 'MSNR', dir, entry: price, ...t, grade,
        reasons: [
          `H4 structure is <strong>${bias}</strong>${stH4.event ? ' (' + stH4.event + ')' : ''}`,
          `Price at <strong>fresh ${atLevel.kind}</strong> ${atLevel.role} ${atLevel.price.toFixed(2)} (${atLevel.tf}, untested)`,
          sweepOk ? `Liquidity sweep of equal ${dir === 'buy' ? 'lows' : 'highs'} at ${sweep.level.toFixed(2)}` : null,
          `M15 confirmation: <strong>${confirm}</strong>`,
          sess.prime ? `Prime session window (${sess.sessions.join(' + ')})` : null,
        ].filter(Boolean),
      };
    }

    // --- Price action setup: BOS/CHoCH + OB/FVG retest with structure ---
    if (!signal && dir && sess.open && (stH1.event || stM15.event)) {
      const zone = detectOBFVG(h1, bias, price, atrH1);
      if (zone && zone.dir === dir && confirm) {
        const rawSl = dir === 'buy'
          ? toPips(price - zone.lo) + 15
          : toPips(zone.hi - price) + 15;
        const t = buildTargets('PA', dir, price, rawSl, atrH1pips);
        signal = {
          kind: 'Price Action', dir, entry: price, ...t, grade,
          reasons: [
            `H4 bias <strong>${bias}</strong>, H1/M15 event: <strong>${stH1.event || stM15.event}</strong>`,
            `Retesting <strong>${zone.type}</strong> zone ${zone.lo.toFixed(2)}–${zone.hi.toFixed(2)} (H1)`,
            `M15 confirmation: <strong>${confirm}</strong>`,
            sweepOk ? `Liquidity sweep at ${sweep.level.toFixed(2)}` : null,
          ].filter(Boolean),
        };
      }
    }

    // --- waiting state: explain what's missing ---
    let waiting = null;
    if (!signal) {
      const above = levels.filter(L => L.role === 'resistance')[0];
      const below = levels.filter(L => L.role === 'support')[0];
      const missing = [];
      if (!sess.open) missing.push('market is closed — gold reopens Sun 22:00 UTC');
      if (bias === 'ranging') missing.push('H4 structure is ranging — no clear bias');
      if (dir && !atLevel) missing.push(`waiting for price to reach a fresh ${dir === 'buy' ? 'support' : 'resistance'} level — no chasing`);
      if (dir && atLevel && !confirm) missing.push('at the level — waiting for an M15 rejection candle (engulfing / pin bar)');
      if (sess.usDataHour) missing.push('US data hour — stand aside through high-impact news');
      waiting = { missing, above, below };
    }

    return {
      price, atrH1pips: Math.round(atrH1pips), levels, sess,
      structure: { h4: stH4, h1: stH1, m15: stM15 },
      checklist, grade, signal, waiting, sweep,
    };
  }

  return { run, sessionInfo, toPips, fromPips, atr };
})();
