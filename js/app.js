/* =====================================================
   BullBytes Gold — UI wiring
   ===================================================== */

(() => {
  const $ = id => document.getElementById(id);
  const fmt = (v, d = 2) => v == null ? '—' : (+v).toFixed(d);

  let lastPrice = null;
  let dayOpenPrice = null;
  let lastResult = null;

  /* ---------- TradingView chart: OANDA XAU/USD (FX gold) ---------- */
  function initChart() {
    if (typeof TradingView === 'undefined') {
      $('tvChart').innerHTML = '<div class="muted center" style="padding:60px 0">Chart unavailable (TradingView blocked on this network)</div>';
      return;
    }
    new TradingView.widget({
      container_id: 'tvChart',
      symbol: 'OANDA:XAUUSD',
      interval: '15',
      autosize: true,
      theme: 'dark',
      style: '1',
      timezone: 'Etc/UTC',
      locale: 'en',
      toolbar_bg: '#161b27',
      enable_publishing: false,
      hide_side_toolbar: false,
      allow_symbol_change: false,
      studies: [],
    });
  }

  /* ---------- live price ---------- */
  async function tickPrice() {
    try {
      const s = await BBData.fetchSpot();
      const el = $('livePrice'), ch = $('liveChange');
      el.textContent = '$' + fmt(s.price);
      if (dayOpenPrice == null) dayOpenPrice = s.price;
      const d = s.price - dayOpenPrice;
      ch.textContent = (d >= 0 ? '+' : '') + fmt(d) + ' (' + (d >= 0 ? '+' : '') + fmt(d / dayOpenPrice * 100, 2) + '%)';
      ch.className = 'pp-change ' + (d >= 0 ? 'up' : 'down');
      lastPrice = s.price;
      updateHistoryStatuses(s.price);
    } catch (e) { /* keep last shown price */ }
  }

  /* ---------- engine cycle ---------- */
  async function runEngine() {
    const dot = $('engineDot'), state = $('engineState');
    dot.className = 'engine-dot';
    state.textContent = 'Analysing live data…';
    try {
      const data = await BBData.fetchAll();
      // 4h post-loss cooldown ("one loss = stop, breathe") — verified to cut
      // drawdowns roughly in half in backtests on real XAU/USD data
      const lastLoss = loadHist().filter(x => x.status === 'SL' && x.closedAt).pop();
      const res = BBEngine.run({ ...data, cooldownUntil: lastLoss ? lastLoss.closedAt + 4 * 3600e3 : 0 });
      lastResult = res;
      renderStatus(res, data);
      renderStructure(res);
      renderLevels(res);
      renderSessions(res);
      renderSignal(res);
      renderChecklist(res);
      if (res.signal) recordSignal(res.signal);
      dot.className = 'engine-dot live';
      state.textContent = 'Live · ' + data.source;
      $('lastUpdate').textContent = new Date().toLocaleTimeString();
    } catch (e) {
      dot.className = 'engine-dot err';
      state.textContent = 'Data error — retrying… (' + (e.message || e) + ')';
    }
  }

  /* ---------- renderers ---------- */

  function renderStatus(res) {
    const ms = $('marketStatus');
    ms.textContent = res.sess.open ? 'OPEN' : 'CLOSED';
    ms.className = 'ss-v ' + (res.sess.open ? 'open' : 'closed');
    $('sessionNow').textContent = res.sess.sessions.length ? res.sess.sessions.join(' + ') : 'Dead zone';
    const hb = $('h4Bias');
    hb.textContent = res.structure.h4.trend.toUpperCase();
    hb.className = 'ss-v ' + (res.structure.h4.trend === 'bullish' ? 'bull' : res.structure.h4.trend === 'bearish' ? 'bear' : '');
    $('atrNow').textContent = res.atrH1pips + ' pips';
    $('volNow').textContent = res.atrH1pips < 100 ? 'Low' : res.atrH1pips < 180 ? 'Normal' : res.atrH1pips < 260 ? 'High' : 'Extreme';
  }

  function tfRow(k, v, cls = '') {
    return `<div class="tf-row"><span class="k">${k}</span><span class="v ${cls}">${v}</span></div>`;
  }

  function renderStructure(res) {
    const blocks = [['tfH4', res.structure.h4], ['tfH1', res.structure.h1], ['tfM15', res.structure.m15]];
    for (const [id, st] of blocks) {
      const cls = st.trend === 'bullish' ? 'bull' : st.trend === 'bearish' ? 'bear' : '';
      $(id).querySelector('.tf-body').innerHTML =
        tfRow('Trend', st.trend.toUpperCase(), cls) +
        tfRow('Last event', st.event || '—', st.event && st.event.includes('↑') ? 'bull' : st.event ? 'bear' : '') +
        tfRow('Last swing high', st.lastHigh ? '$' + fmt(st.lastHigh.price) : '—') +
        tfRow('Last swing low', st.lastLow ? '$' + fmt(st.lastLow.price) : '—');
    }
  }

  function renderLevels(res) {
    const rows = res.levels.slice(0, 12).map(L => {
      const dist = BBEngine.toPips(Math.abs(L.price - res.price)).toFixed(0);
      return `<tr>
        <td>$${fmt(L.price)}</td>
        <td>${L.tf}</td>
        <td><span class="tag ${L.role === 'support' ? 'sup' : 'res'}">${L.role}</span></td>
        <td><span class="tag ${L.fresh ? 'fresh' : 'tested'}">${L.fresh ? 'FRESH' : 'tested ×' + L.touches}</span>${L.flip ? ' <span class="tag flip">FLIP</span>' : ''}</td>
        <td>${L.kind}</td>
        <td>${dist} pips</td>
        <td><span class="strength-bar"><i style="width:${L.strength}%"></i></span></td>
      </tr>`;
    }).join('');
    $('levelsBody').innerHTML = rows || '<tr><td colspan="7" class="muted center">No significant levels in range.</td></tr>';
  }

  function renderSessions(res) {
    const defs = [
      { name: 'Asia', utc: '23:00 – 07:00 UTC', desc: 'Range builds. Mark the Asia high/low — that liquidity usually gets swept later.' },
      { name: 'London', utc: '07:00 – 16:00 UTC', desc: 'First real move — often the fake one. Watch for the sweep of the Asia range into an MSNR level.' },
      { name: 'New York', utc: '12:00 – 21:00 UTC', desc: 'The true move and biggest volume. Best setups: London sweep → NY continuation.' },
    ];
    $('sessionsGrid').innerHTML = defs.map(d => {
      const active = res.sess.sessions.includes(d.name === 'New York' ? 'New York' : d.name);
      return `<div class="panel session-card ${active ? 'active-session' : ''}">
        ${active ? '<span class="live-badge">● LIVE</span>' : ''}
        <h3>${d.name}</h3>
        <div class="times">${d.utc}</div>
        <p>${d.desc}</p>
      </div>`;
    }).join('');
  }

  function priceBox(cls, k, v, pips) {
    return `<div class="sc-pr ${cls}"><div class="k">${k}</div><div class="v">$${fmt(v)}</div><div class="p">${pips}</div></div>`;
  }

  function renderSignal(res) {
    const card = $('signalCard');
    if (res.signal) {
      const s = res.signal;
      card.className = 'signal-card ' + s.dir;
      card.innerHTML = `
        <div class="sc-top">
          <span class="sc-dir ${s.dir}">${s.dir.toUpperCase()}</span>
          <span class="sc-type">${s.kind} setup · Grade ${s.grade}</span>
          <span class="sc-time">${new Date().toUTCString().slice(17, 25)} UTC</span>
        </div>
        <div class="sc-prices">
          ${priceBox('entry', 'Entry', s.entry, 'market')}
          ${priceBox('sl', 'Stop Loss', s.sl, s.slPips + ' pips')}
          ${priceBox('tp', 'TP 1', s.tps[0], s.tp1Pips + ' pips')}
          ${priceBox('tp', 'TP 2', s.tps[1], s.tp2Pips + ' pips')}
          ${priceBox('tp', 'TP 3', s.tps[2], s.tp3Pips + ' pips')}
        </div>
        <div class="sc-reason"><strong>Why this trade:</strong>
          <ul>${s.reasons.map(r => '<li>' + r + '</li>').join('')}</ul>
        </div>
        <div class="sc-rr">Plan: take partials at TP1 (${s.tp1Pips} pips) → move SL to breakeven → let TP2/TP3 run.
        Risk:reward to TP3 ≈ 1:${(s.tp3Pips / s.slPips).toFixed(1)} · 1 SL / 3 TPs · max 1–2% account risk.</div>`;
    } else if (res.waiting) {
      const w = res.waiting;
      card.className = 'signal-card';
      card.innerHTML = `
        <div class="sc-top">
          <span class="sc-dir wait">NO TRADE — WAIT</span>
          <span class="sc-time">${new Date().toUTCString().slice(17, 25)} UTC</span>
        </div>
        <div class="sc-wait-title">The engine is flat. Discipline = edge.</div>
        <div class="sc-reason"><strong>Waiting for:</strong>
          <ul>${w.missing.map(m => '<li>' + m + '</li>').join('') || '<li>full confluence</li>'}</ul>
        </div>
        <div class="sc-prices" style="grid-template-columns:repeat(2,1fr)">
          ${w.above ? priceBox('sl', 'Next resistance ' + (w.above.fresh ? '(fresh)' : ''), w.above.price, BBEngine.toPips(w.above.price - res.price).toFixed(0) + ' pips away') : ''}
          ${w.below ? priceBox('tp', 'Next support ' + (w.below.fresh ? '(fresh)' : ''), w.below.price, BBEngine.toPips(res.price - w.below.price).toFixed(0) + ' pips away') : ''}
        </div>
        <div class="sc-rr">A valid signal needs: H4 bias + fresh MSNR level + M15 rejection. Sweeps and session timing upgrade the grade.</div>`;
    }
  }

  function renderChecklist(res) {
    document.querySelectorAll('#checklist li').forEach(li => {
      const ok = res.checklist[li.dataset.k];
      li.className = ok ? 'ok' : 'no';
    });
    $('setupGrade').textContent = res.grade;
  }

  /* ---------- signal history (localStorage) ---------- */

  const HKEY = 'bb_gold_signals';
  const loadHist = () => { try { return JSON.parse(localStorage.getItem(HKEY)) || []; } catch { return []; } };
  const saveHist = h => localStorage.setItem(HKEY, JSON.stringify(h.slice(-50)));

  function recordSignal(s) {
    const hist = loadHist();
    const key = s.kind + s.dir + Math.round(s.entry / 2) * 2; // dedupe nearby duplicates
    if (hist.some(x => x.key === key && x.status.startsWith('TP') === false && x.status !== 'SL' && Date.now() - x.t < 12 * 3600e3)) return;
    if (hist.some(x => x.key === key && Date.now() - x.t < 12 * 3600e3)) return;
    hist.push({ key, t: Date.now(), kind: s.kind, dir: s.dir, entry: s.entry, sl: s.sl, tps: s.tps, status: 'ACTIVE' });
    saveHist(hist);
    renderHistory();
  }

  function updateHistoryStatuses(price) {
    const hist = loadHist();
    let changed = false;
    for (const x of hist) {
      if (x.status === 'SL' || x.status === 'TP3') continue;
      const s = x.dir === 'buy' ? 1 : -1;
      if (s * (price - x.sl) <= 0) {
        x.status = x.status.startsWith('TP') ? x.status + '+BE' : 'SL';
        x.closedAt = Date.now();
        changed = true; continue;
      }
      if (s * (price - x.tps[2]) >= 0) { x.status = 'TP3'; changed = true; }
      else if (s * (price - x.tps[1]) >= 0 && x.status !== 'TP2') { x.status = 'TP2'; changed = true; }
      else if (s * (price - x.tps[0]) >= 0 && x.status === 'ACTIVE') { x.status = 'TP1'; changed = true; }
    }
    if (changed) { saveHist(hist); renderHistory(); }
  }

  function renderHistory() {
    const hist = loadHist().slice().reverse();
    const body = $('historyBody');
    if (!hist.length) {
      body.innerHTML = '<tr><td colspan="9" class="muted center">No signals recorded yet — they appear here as the engine fires.</td></tr>';
      $('histStats').innerHTML = '';
      return;
    }
    body.innerHTML = hist.map(x => {
      const cls = x.status === 'SL' ? 'loss' : x.status.startsWith('TP') ? 'win' : 'active';
      return `<tr>
        <td>${new Date(x.t).toLocaleString()}</td>
        <td>${x.kind}</td>
        <td><span class="tag ${x.dir === 'buy' ? 'sup' : 'res'}">${x.dir.toUpperCase()}</span></td>
        <td>$${fmt(x.entry)}</td>
        <td>$${fmt(x.sl)}</td>
        <td>$${fmt(x.tps[0])}</td>
        <td>$${fmt(x.tps[1])}</td>
        <td>$${fmt(x.tps[2])}</td>
        <td><span class="tag ${cls}">${x.status}</span></td>
      </tr>`;
    }).join('');
    const done = hist.filter(x => x.status === 'SL' || x.status.startsWith('TP'));
    const wins = done.filter(x => x.status.startsWith('TP')).length;
    $('histStats').innerHTML = done.length
      ? `<span>Closed: <b>${done.length}</b></span><span>TP hits: <b>${wins}</b></span><span>Win rate: <b>${Math.round(wins / done.length * 100)}%</b></span>`
      : `<span>Active: <b>${hist.length}</b></span>`;
  }

  /* ---------- strategy picker ---------- */

  let pickedStrat = null;
  let scanCooldownT = 0;

  function renderPicker() {
    $('pickerGrid').innerHTML = BBStrats.list.map(s => `
      <div class="pick-card" data-id="${s.id}">
        <div class="pick-top"><span class="pick-icon">${s.icon}</span><span class="pick-name">${s.name}</span>
        <span class="tag ${s.type === 'Scalp' ? 'fresh' : 'flip'}">${s.type}</span></div>
        <p>${s.desc}</p>
        <div class="pick-window">⏱ ${s.window}</div>
        ${s.stats ? `<div class="pick-stats ${s.stats.net.includes('profitable') ? 'good' : s.stats.net.includes('breakeven') ? 'mid' : 'bad'}">📊 ${s.stats.acc} accuracy · ${s.stats.label}</div>` : ''}
      </div>`).join('');
    document.querySelectorAll('.pick-card').forEach(el => el.addEventListener('click', () => {
      document.querySelectorAll('.pick-card').forEach(x => x.classList.remove('selected'));
      el.classList.add('selected');
      pickedStrat = BBStrats.list.find(s => s.id === el.dataset.id);
      $('scanHint').textContent = pickedStrat.name + ' selected — hit the button to scan live data';
    }));
  }

  async function scan() {
    if (!pickedStrat) { $('scanHint').textContent = '⚠ Select a strategy first'; return; }
    if (Date.now() < scanCooldownT) return;
    scanCooldownT = Date.now() + 5000;
    const btn = $('scanBtn');
    btn.disabled = true; btn.textContent = '⏳ Scanning live gold data…';
    try {
      const data = await BBData.fetchAll();
      const m5 = await BBData.fetchM5(data.offset);
      const lastLoss = loadHist().filter(x => x.status === 'SL' && x.closedAt).pop();
      const ctx = { ...data, m5, now: Date.now(), cooldownUntil: lastLoss ? lastLoss.closedAt + 4 * 3600e3 : 0 };
      const out = pickedStrat.run(ctx);
      renderScanResult(out, data.spot.price);
      if (out.signal) recordSignal(out.signal);
    } catch (e) {
      $('scanResult').innerHTML = `<div class="signal-card" style="margin-top:18px"><div class="sc-wait-title">Data error — try again</div><div class="muted">${e.message || e}</div></div>`;
    }
    btn.disabled = false; btn.textContent = '⚡ Get Signal Now';
  }

  function renderScanResult(out, price) {
    const box = $('scanResult');
    if (out.signal) {
      const s = out.signal;
      box.innerHTML = `
      <div class="signal-card ${s.dir}" style="margin-top:18px">
        <div class="sc-top">
          <span class="sc-dir ${s.dir}">${s.dir.toUpperCase()}</span>
          <span class="sc-type">${s.kind}${s.grade ? ' · Grade ' + s.grade : ''}</span>
          <span class="sc-time">${new Date().toUTCString().slice(17, 25)} UTC · XAU/USD $${fmt(price)}</span>
        </div>
        <div class="sc-prices">
          ${priceBox('entry', 'Entry', s.entry, 'market')}
          ${priceBox('sl', 'Stop Loss', s.sl, s.slPips + ' pips')}
          ${priceBox('tp', 'TP 1', s.tps[0], s.tp1Pips + ' pips')}
          ${priceBox('tp', 'TP 2', s.tps[1], s.tp2Pips + ' pips')}
          ${priceBox('tp', 'TP 3', s.tps[2], s.tp3Pips + ' pips')}
        </div>
        <div class="sc-reason"><strong>Why this trade:</strong>
          <ul>${s.reasons.map(r => '<li>' + r + '</li>').join('')}</ul>
        </div>
        <div class="sc-rr">${s.plan || ''} · 1 SL / 3 TPs · partials at TP1 → SL to breakeven.</div>
      </div>`;
    } else {
      box.innerHTML = `
      <div class="signal-card" style="margin-top:18px">
        <div class="sc-top"><span class="sc-dir wait">NO TRADE — WAIT</span>
        <span class="sc-time">${new Date().toUTCString().slice(17, 25)} UTC</span></div>
        <div class="sc-wait-title">${pickedStrat.icon} ${pickedStrat.name}: conditions not met. Sitting on your hands IS a position.</div>
        <div class="sc-reason"><strong>Status:</strong>
          <ul>${out.waiting.map(m => '<li>' + m + '</li>').join('')}</ul>
        </div>
      </div>`;
    }
  }

  /* ---------- risk calculator ---------- */

  function calc() {
    const bal = +$('calcBalance').value || 0;
    const riskPct = +$('calcRisk').value || 0;
    const sl = +$('calcSL').value || 1;
    const riskAmt = bal * riskPct / 100;
    const lots = riskAmt / (sl * 10); // $10 per pip per 1.00 lot
    $('calcResults').innerHTML = `
      <div class="cr-box"><div class="k">Risk amount</div><div class="v">$${riskAmt.toFixed(2)}</div></div>
      <div class="cr-box"><div class="k">Lot size</div><div class="v">${Math.max(0.01, Math.floor(lots * 100) / 100).toFixed(2)}</div></div>
      <div class="cr-box"><div class="k">Per-pip value</div><div class="v">$${(Math.max(0.01, Math.floor(lots * 100) / 100) * 10).toFixed(2)}</div></div>
      <div class="cr-box"><div class="k">SL distance</div><div class="v">$${(sl * 0.10).toFixed(2)}</div></div>`;
  }

  /* ---------- boot ---------- */

  $('year').textContent = new Date().getFullYear();
  initChart();
  renderPicker();
  renderHistory();
  calc();
  ['calcBalance', 'calcRisk', 'calcSL'].forEach(id => $(id).addEventListener('input', calc));
  $('refreshBtn').addEventListener('click', runEngine);
  $('scanBtn').addEventListener('click', scan);

  tickPrice();
  runEngine();
  setInterval(tickPrice, 15000);   // live price every 15s
  setInterval(runEngine, 60000);   // full re-analysis every 60s
})();
