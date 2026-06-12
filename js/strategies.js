/* =====================================================
   BullBytes Gold — selectable strategy scanners
   Each strategy implements run(ctx) -> { signal } or
   { waiting: [reasons] }.
   ctx = { m5, m15, h1, h4, spot, now }   (all calibrated
   to live spot XAU/USD; gold pip = $0.10)
   Every signal: 1 SL + 3 TPs.
   Scalp risk rules: 0.5–1% per trade, London/NY only,
   2-3 trades/day max — enforced via copy + cooldowns.
   ===================================================== */

const BBStrats = (() => {

  const PIP = 0.10;
  const toPips = d => d / PIP;
  const fromPips = p => p * PIP;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const bodyHi = c => Math.max(c.o, c.c);
  const bodyLo = c => Math.min(c.o, c.c);
  const bodySize = c => Math.abs(c.c - c.o);

  function ema(candles, n) {
    const k = 2 / (n + 1);
    let e = candles[0].c;
    const out = [e];
    for (let i = 1; i < candles.length; i++) { e = candles[i].c * k + e * (1 - k); out.push(e); }
    return out;
  }

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

  // last CLOSED m5 rejection candle in a direction (at an optional level)
  function m5Confirm(m5, dir, level) {
    const c = m5[m5.length - 2], p = m5[m5.length - 3];
    if (!c || !p) return null;
    const b = bodySize(c), r = c.h - c.l;
    if (r === 0) return null;
    if (dir === 'buy') {
      if (c.c > c.o && p.c < p.o && c.c >= bodyHi(p) && c.o <= bodyLo(p)) return 'bullish engulfing';
      if ((Math.min(c.o, c.c) - c.l) >= 2 * b && (c.c - c.l) / r >= 0.6) return 'bullish pin bar';
      if (level != null && c.l < level - 0.2 && c.c > level && c.c > c.o) return 'close back above level';
    } else {
      if (c.c < c.o && p.c > p.o && c.c <= bodyLo(p) && c.o >= bodyHi(p)) return 'bearish engulfing';
      if ((c.h - Math.max(c.o, c.c)) >= 2 * b && (c.h - c.c) / r >= 0.6) return 'bearish pin bar';
      if (level != null && c.h > level + 0.2 && c.c < level && c.c < c.o) return 'close back below level';
    }
    return null;
  }

  function sig(kind, dir, entry, slPrice, tpPipsArr, reasons, plan) {
    let slPips = Math.round(toPips(Math.abs(entry - slPrice)));
    slPips = clamp(slPips, 15, 100);
    const s = dir === 'buy' ? 1 : -1;
    const tps = tpPipsArr.map(p => entry + s * fromPips(p));
    return {
      signal: {
        kind, dir, entry,
        sl: entry - s * fromPips(slPips), slPips,
        tps, tp1Pips: Math.round(tpPipsArr[0]), tp2Pips: Math.round(tpPipsArr[1]), tp3Pips: Math.round(tpPipsArr[2]),
        reasons, plan,
      }
    };
  }

  const utcHour = now => { const d = new Date(now); return d.getUTCHours() + d.getUTCMinutes() / 60; };
  const PKT = '(PKT = UTC+5)';

  /* ============ 1. Asian Range Breakout-Fakeout ============ */
  function asianRange({ m15, m5, spot, now }) {
    const price = spot.price;
    const h = utcHour(now);
    const dayStart = new Date(now); dayStart.setUTCHours(0, 0, 0, 0);
    const asia = m15.filter(c => c.t >= +dayStart && c.t < +dayStart + 7 * 3600e3);
    if (asia.length < 8) return { waiting: ['Asia range (5am–12pm PKT) not formed yet — come back during/after the Asian session'] };
    const hi = Math.max(...asia.map(c => c.h)), lo = Math.min(...asia.map(c => c.l));
    const rangePips = toPips(hi - lo);
    if (h < 7) return { waiting: [`Asia range building: ${lo.toFixed(2)} – ${hi.toFixed(2)} (${rangePips.toFixed(0)} pips). Wait for London open (12pm PKT) to hunt the fakeout`] };
    if (h >= 12) return { waiting: ['London fakeout window (12pm–5pm PKT) is over for today — next setup tomorrow at London open'] };
    // look for a sweep + close back inside on M5 since 07:00 UTC
    const lon = m5.filter(c => c.t >= +dayStart + 7 * 3600e3 && c.t < now - 2 * 60e3);
    let sweep = null;
    for (const c of lon) {
      if (c.h > hi + 0.3) sweep = { side: 'high', ext: Math.max(sweep && sweep.side === 'high' ? sweep.ext : 0, c.h), backIn: false };
      if (sweep && sweep.side === 'high' && c.c < hi) sweep.backIn = true;
      if (c.l < lo - 0.3 && !(sweep && sweep.backIn)) sweep = { side: 'low', ext: Math.min(sweep && sweep.side === 'low' ? sweep.ext : 1e9, c.l), backIn: false };
      if (sweep && sweep.side === 'low' && c.c > lo) sweep.backIn = true;
    }
    if (!sweep) return { waiting: [`Asia range ${lo.toFixed(2)} – ${hi.toFixed(2)} marked. London hasn't swept either side yet — wait for the spike through the high or low`] };
    if (!sweep.backIn) return { waiting: [`London swept the Asia ${sweep.side} — now wait for an M5 candle to CLOSE back inside the range to confirm the fakeout`] };
    const dir = sweep.side === 'high' ? 'sell' : 'buy';
    const conf = m5Confirm(m5, dir, dir === 'sell' ? hi : lo);
    if (!conf) return { waiting: [`Fakeout of the Asia ${sweep.side} confirmed — waiting for an M5 rejection candle to close before entry`] };
    const slPrice = dir === 'sell' ? sweep.ext + 2.5 : sweep.ext - 2.5;
    const slPips = toPips(Math.abs(price - slPrice));
    const mid = toPips(Math.abs(price - (hi + lo) / 2));
    const opp = toPips(Math.abs(price - (dir === 'sell' ? lo : hi)));
    return sig('Asian Fakeout', dir, price, slPrice,
      [Math.max(mid, slPips * 0.8), Math.max(opp, mid + 20), Math.max(opp + rangePips * 0.3, opp + 30)],
      [`Asia range ${lo.toFixed(2)} – ${hi.toFixed(2)} (${rangePips.toFixed(0)} pips)`,
       `London swept the ${sweep.side} (stop hunt) and closed back inside — trap sprung`,
       `M5 confirmation: ${conf}`],
      'One clean setup per day. Trade WITH the trap. Risk 0.5–1% max.');
  }

  /* ============ 2. MSNR Flip Scalp (M15 → M5) ============ */
  function flipScalp({ m15, m5, spot, now }) {
    const price = spot.price;
    const h = utcHour(now);
    if (h < 7 || h >= 21) return { waiting: ['Scalp window closed — flip scalps fire during London/NY (12pm–2am PKT). Quality jumps massively in session'] };
    const { highs, lows } = findSwings(m15.slice(-120), 2);
    const tol = 2.0;
    // find a body level broken with a body close in the last ~30 m15 candles, now retesting
    const recent = m15.slice(-30);
    let setup = null;
    for (const s of [...highs.slice(-6), ...lows.slice(-6)]) {
      const cand = m15[m15.length - 120 + s.i] || m15[s.i];
      const lvl = highs.includes(s) ? bodyHi(cand) : bodyLo(cand);
      let broke = null;
      for (let i = 1; i < recent.length; i++) {
        if (recent[i - 1].c > lvl - tol * 0.2 && recent[i].c < lvl - tol * 0.8) broke = 'sell';
        if (recent[i - 1].c < lvl + tol * 0.2 && recent[i].c > lvl + tol * 0.8) broke = 'buy';
      }
      if (broke && Math.abs(price - lvl) <= tol * 1.5) { setup = { lvl, dir: broke }; break; }
    }
    if (!setup) return { waiting: ['No M15 level has both (a) a recent body-close break and (b) a retest happening right now. Patience — the retest IS the trade'] };
    const conf = m5Confirm(m5, setup.dir, setup.lvl);
    if (!conf) return { waiting: [`Price is retesting the flipped level at ${setup.lvl.toFixed(2)} — wait for an M5 rejection candle (pin bar / engulfing) to CLOSE before entering`] };
    const rej = m5[m5.length - 2];
    const slPrice = setup.dir === 'buy' ? rej.l - 2.0 : rej.h + 2.0;
    const slPips = clamp(toPips(Math.abs(price - slPrice)), 15, 60);
    return sig('MSNR Flip Scalp', setup.dir, price, setup.dir === 'buy' ? price - fromPips(slPips) : price + fromPips(slPips),
      [slPips, slPips * 2, slPips * 3],
      [`M15 level ${setup.lvl.toFixed(2)} broke with a body close — old ${setup.dir === 'sell' ? 'support is now resistance' : 'resistance is now support'}`,
       'Price is retesting the flip — trapped traders bailing out fuel the move',
       `M5 confirmation: ${conf}`],
      'TP2 = the classic 1:2 fixed target. Risk 0.5–1%.');
  }

  /* ============ 3. EMA Pullback Scalp (9/21 EMA, M5) ============ */
  function emaPullback({ m5, spot, now }) {
    const price = spot.price;
    const h = utcHour(now);
    if (h < 7 || h >= 21) return { waiting: ['London/NY only — trend scalps in Asia just pay spread to lose slowly'] };
    const closed = m5.slice(0, -1);
    const e9 = ema(closed, 9), e21 = ema(closed, 21);
    const n = closed.length - 1;
    const slope = e21[n] - e21[n - 12]; // 1h of slope
    const spread = Math.abs(e9[n] - e21[n]);
    const trending = Math.abs(slope) > 1.2 && spread > 0.8;
    if (!trending) return { waiting: ['EMAs are flat/tangled = no trend = NO TRADE. This strategy dies in ranges — wait for 9/21 EMA to separate and point one way'] };
    const dir = slope > 0 ? 'buy' : 'sell';
    const last = closed[n];
    const touched = dir === 'buy' ? last.l <= e21[n] + 0.4 && last.c > e21[n] : last.h >= e21[n] - 0.4 && last.c < e21[n];
    const prevTouched = dir === 'buy' ? closed[n - 1].l <= e21[n - 1] + 0.4 : closed[n - 1].h >= e21[n - 1] - 0.4;
    if (!touched && !prevTouched) return { waiting: [`Clear ${dir === 'buy' ? 'up' : 'down'}trend (9>21 EMA ${dir === 'buy' ? '' : 'inverted '}with slope) — but no pullback to the 21 EMA yet. Don't chase: let price come back to the EMA`] };
    const conf = m5Confirm(m5, dir, e21[n]);
    if (!conf) return { waiting: ['Price is at the 21 EMA — waiting for a CLOSED engulfing/pin bar at the EMA before entry'] };
    const lows = closed.slice(-6);
    const slPrice = dir === 'buy' ? Math.min(...lows.map(c => c.l)) - 1.5 : Math.max(...lows.map(c => c.h)) + 1.5;
    const slPips = clamp(toPips(Math.abs(price - slPrice)), 15, 60);
    return sig('EMA Pullback', dir, price, dir === 'buy' ? price - fromPips(slPips) : price + fromPips(slPips),
      [Math.round(slPips * 1.5), slPips * 2, Math.round(slPips * 2.5)],
      [`Strong M5 ${dir === 'buy' ? 'up' : 'down'}trend — 9/21 EMA separated and sloping`,
       'Pullback touched the 21 EMA: big players reloading, you buy the discount with them',
       `M5 confirmation: ${conf}`],
      'Take TP1/TP2 and get out — no greed on a scalp.');
  }

  /* ============ 4. NY Open Momentum Scalp ============ */
  function nyMomentum({ m15, m5, spot, now }) {
    const price = spot.price;
    const h = utcHour(now);
    if (h < 12.5 || h >= 14) return { waiting: ['Outside the NY open window (5:30–7:00pm PKT / 12:30–14:00 UTC) — gold\'s most explosive hour. Come back at the open. Skip if red news within 30 min!'] };
    const dayStart = new Date(now); dayStart.setUTCHours(0, 0, 0, 0);
    const pre = m15.filter(c => c.t < +dayStart + 12.5 * 3600e3).slice(-40);
    const { highs, lows } = findSwings(pre, 2);
    if (!highs.length || !lows.length) return { waiting: ['Not enough pre-NY structure yet'] };
    const swingHi = highs[highs.length - 1].price, swingLo = lows[lows.length - 1].price;
    const ny = m5.filter(c => c.t >= +dayStart + 12.5 * 3600e3 && c.t <= now - 2 * 60e3);
    let momo = null;
    for (let i = 0; i < ny.length; i++) {
      const c = ny[i];
      const prev5 = m5.slice(Math.max(0, m5.indexOf(c) - 5), m5.indexOf(c));
      const big = prev5.length === 5 && bodySize(c) > Math.max(...prev5.map(bodySize));
      if (big && c.c > swingHi) momo = { dir: 'buy', c };
      if (big && c.c < swingLo) momo = { dir: 'sell', c };
    }
    if (!momo) return { waiting: [`Pre-open swings marked: high ${swingHi.toFixed(2)} / low ${swingLo.toFixed(2)}. Waiting for the first M5 momentum candle (body bigger than the last 5) to CLOSE beyond one of them`] };
    if (now - momo.c.t > 20 * 60e3) return { waiting: ['The momentum candle fired more than 20 min ago — entry window missed, don\'t chase it'] };
    const mid = (momo.c.o + momo.c.c) / 2;
    const slPips = clamp(toPips(Math.abs(price - mid)), 15, 80);
    return sig('NY Momentum', momo.dir, price, momo.dir === 'buy' ? price - fromPips(slPips) : price + fromPips(slPips),
      [slPips, slPips * 2, Math.round(slPips * 2.8)],
      [`NY open volume surge — first M5 momentum candle closed ${momo.dir === 'buy' ? 'above pre-open swing high ' + swingHi.toFixed(2) : 'below pre-open swing low ' + swingLo.toFixed(2)}`,
       'Body bigger than the previous 5 candles = real institutional push',
       'SL at the middle of the momentum candle'],
      'TP2 = the 1:2 target. Or trail behind each new M5 low/high. NO red news within 30 min.');
  }

  /* ============ 5. Double Top/Bottom Sweep Scalp ============ */
  function doubleSweep({ m15, m5, spot, now }) {
    const price = spot.price;
    const h = utcHour(now);
    if (h < 7 || h >= 21) return { waiting: ['London/NY sessions only for this scalp'] };
    const { highs, lows } = findSwings(m15.slice(-80), 2);
    const eqTol = 1.5;
    let setup = null;
    for (const arr of [{ s: highs, side: 'high' }, { s: lows, side: 'low' }]) {
      const sw = arr.s.slice(-8);
      for (let i = 0; i < sw.length - 1 && !setup; i++)
        for (let j = i + 1; j < sw.length && !setup; j++)
          if (Math.abs(sw[i].price - sw[j].price) <= eqTol)
            setup = { lvl: (sw[i].price + sw[j].price) / 2, side: arr.side };
    }
    if (!setup) return { waiting: ['No clean equal highs / equal lows (double top/bottom) on M15 right now — no liquidity pool to trap'] };
    // sweep on m5 within last 12 candles
    const recent = m5.slice(-14, -1);
    let sweep = null;
    for (const c of recent) {
      if (setup.side === 'high' && c.h > setup.lvl + 0.3) sweep = { ext: Math.max(sweep ? sweep.ext : 0, c.h) };
      if (setup.side === 'low' && c.l < setup.lvl - 0.3) sweep = { ext: Math.min(sweep ? sweep.ext : 1e9, c.l) };
    }
    if (!sweep) return { waiting: [`Equal ${setup.side}s at ${setup.lvl.toFixed(2)} marked (retail stops resting there). DON'T trade the pattern — wait for the sweep through it first`] };
    const dir = setup.side === 'high' ? 'sell' : 'buy';
    const conf = m5Confirm(m5, dir, setup.lvl);
    if (!conf) return { waiting: [`Stops at the equal ${setup.side}s just got swept — wait for a strong M5 reversal candle to CLOSE back ${dir === 'sell' ? 'below' : 'above'} ${setup.lvl.toFixed(2)}`] };
    const slPrice = dir === 'sell' ? sweep.ext + 2.0 : sweep.ext - 2.0;
    const slPips = clamp(toPips(Math.abs(price - slPrice)), 15, 60);
    return sig('Double-Top Sweep', dir, price, dir === 'sell' ? price + fromPips(slPips) : price - fromPips(slPips),
      [slPips, slPips * 2, Math.round(slPips * 2.8)],
      [`Equal ${setup.side}s at ${setup.lvl.toFixed(2)} — a resting retail stop pool`,
       'Sweep ran the stops; you enter AFTER the trap, with the banks — not at the pattern like retail',
       `M5 confirmation: ${conf}`],
      'TP1 mid-range, runners to the opposite side. Risk 0.5–1%.');
  }

  /* ============ 6 & 7. Swing engine (MSNR / Price Action) ============ */
  function swing(kindWanted) {
    return ctx => {
      const res = BBEngine.run(ctx);
      if (res.signal && res.signal.kind === kindWanted) return { signal: { ...res.signal, plan: 'Partials at TP1 → SL to breakeven → let TP2/TP3 run. Risk 1–2%.' } };
      if (res.signal) return { waiting: [`The engine found a ${res.signal.kind} setup instead — switch strategy to see it, or wait for a ${kindWanted} setup`] };
      return { waiting: res.waiting ? res.waiting.missing : ['No setup'] };
    };
  }

  const list = [
    { id: 'asian', name: 'Asian Fakeout', icon: '🌅', type: 'Scalp', window: 'London open 12–5pm PKT', desc: 'London sweeps the Asia range to grab stops, then reverses. Trade WITH the trap.', run: asianRange },
    { id: 'flipscalp', name: 'MSNR Flip Scalp', icon: '🔄', type: 'Scalp', window: 'London + NY', desc: 'Broken M15 body level retested — enter on the M5 rejection in the break direction.', run: flipScalp },
    { id: 'emapull', name: 'EMA Pullback', icon: '📈', type: 'Scalp', window: 'London + NY', desc: '9/21 EMA trend rider. Buy the pullback to the 21 EMA in a strong trend. Dies in ranges.', run: emaPullback },
    { id: 'nymomo', name: 'NY Momentum', icon: '🚀', type: 'Scalp', window: '5:30–7pm PKT', desc: "Gold's most explosive hour. First M5 momentum candle beyond the pre-open swing.", run: nyMomentum },
    { id: 'dsweep', name: 'Double-Top Sweep', icon: '🪤', type: 'Scalp', window: 'London + NY', desc: 'Equal highs/lows = stop pool. Enter after the sweep, with the banks — not at the pattern.', run: doubleSweep },
    { id: 'msnr', name: 'MSNR Swing', icon: '🎯', type: 'Swing', window: 'All sessions', desc: 'Fresh body levels, gaps, flips on H4/H1 with M15 confirmation. The full combined model.', run: swing('MSNR') },
    { id: 'pa', name: 'Price Action Swing', icon: '🧱', type: 'Swing', window: 'All sessions', desc: 'BOS/CHoCH + order block / FVG retest with the H4 trend. Rare but highest accuracy.', run: swing('Price Action') },
  ];

  return { list };
})();
