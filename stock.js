/* Night Shift — the Stock tab: one stock, tonight and its past weekends.
   Uses the page's own helpers (money, pct, verdict, getJSON, DATA, ADDR …).
   Past weekends come from Stock Check's price log on the stocks-data branch of
   araxis33/base-tools, read the same way stocks.html reads it: a weekend is a
   run of closed-market snapshots that includes a Saturday or Sunday, ended by
   the first snapshot taken with the market open. */
(function () {
  'use strict';
  const SNAPS = 'https://raw.githubusercontent.com/araxis33/base-tools/stocks-data/snapshots.jsonl';
  const THIN_RT = 2; // % lost on a $1,000 round trip just before the open: above this the Base price was not a price
  const SCAN = 'https://basescan.org/token/';
  const TOKENS = (window.ThesisCore && ThesisCore.TOKENS) || [];
  const CO = Object.fromEntries(TOKENS.map((t) => [t.s, t.co]));
  const VENUE = {
    aerodrome: 'Aerodrome', aero: 'Aerodrome', uniswap: 'Uniswap', uniswapv3: 'Uniswap v3', 'uniswap-v4-b20': 'Uniswap v4',
    pancake: 'PancakeSwap', 'kyberswap-limit-order': 'KyberSwap limit orders',
    'metric-propamm': 'Metric (market maker)', 'kipseli-prop': 'Kipseli (market maker)', 'spire-prop': 'Spire (market maker)', fermi: 'Fermi (market maker)',
  };
  const venueName = (v) => VENUE[v] || 'a market maker';
  const coOf = (sym) => (CO[sym] && CO[sym] !== sym.replace(/c$/, '') ? CO[sym] : '');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nyDay = (ts) => new Date(ts * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'America/New_York' });

  let weekendsP = null;
  function loadWeekends() {
    if (weekendsP) return weekendsP;
    weekendsP = fetch(SNAPS, { cache: 'no-store' }).then((r) => { if (!r.ok) throw new Error(r.status); return r.text(); }).then((txt) => {
      const snaps = txt.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
      snaps.sort((a, b) => a.t - b.t);
      snaps.forEach((s) => { s.open = s.rows.filter((x) => s.t - x.share_time < 900).length >= 5; });
      const runs = []; let cur = null;
      snaps.forEach((s) => {
        if (s.open) { if (cur) { cur.after = s; runs.push(cur); cur = null; } return; }
        if (!cur) cur = { snaps: [] };
        cur.snaps.push(s);
      });
      return runs.filter((r) => r.snaps.some((s) => { const d = new Date(s.t * 1000).getUTCDay(); return d === 6 || d === 0; }));
    }).catch(() => { weekendsP = null; return []; });
    return weekendsP;
  }

  function weekendRow(run, sym) {
    // A stock listed mid-weekend is missing from the first snapshots; its Friday close is the same in any of them.
    const first = run.snaps[0], last = run.snaps[run.snaps.length - 1];
    const f = run.snaps.map((s) => s.rows.find((x) => x.s === sym)).find(Boolean);
    const l = last.rows.find((x) => x.s === sym), m = run.after.rows.find((x) => x.s === sym);
    if (!f || !l || !m || !f.share || !l.dex || !m.share) return null;
    // The price being judged is the last one before the bell, so the market is judged at that moment: a pool
    // that went thin for an hour on Sunday says nothing about the price it showed on Monday morning.
    const worst = l.roundtrip_1000 == null ? Infinity : l.roundtrip_1000;
    return { from: first.t, to: run.after.t, close: f.share, base: l.dex, monday: m.share, night: (l.dex / f.share - 1) * 100, open: (m.share / f.share - 1) * 100, worst };
  }

  function lendingHtml(st, sym) {
    const rows = [];
    (st.aave || []).forEach((m) => rows.push(['Aave · ' + esc(m.loan) + ' up to ' + m.ltv.toFixed(0) + '%', m.apy.toFixed(2) + '% · ' + money(m.free).replace(/\.\d\d$/, '') + ' free']));
    (st.morpho || []).slice(0, 2).forEach((m) => rows.push(['Morpho · ' + esc(m.loan) + ' up to ' + m.ltv.toFixed(0) + '%', m.apy.toFixed(2) + '% · ' + money(m.free).replace(/\.\d\d$/, '') + ' free']));
    if (!rows.length) return '<p>No Aave or Morpho market takes ' + sym + ' yet.</p>';
    return rows.map(([k, v]) => `<div class="kv"><span>${k}</span><b>${v}</b></div>`).join('') + '<p>Pledge it and borrow without selling. Borrow rate · what is free to borrow.</p>';
  }

  async function render(ticker) {
    const view = $('viewStock');
    const [sd, cl] = await DATA;
    const sym = ticker + 'c';
    const st = sd.items[sym], c = cl.items[ticker], addr = ADDR[sym];
    if (!st || !addr) { view.innerHTML = `<p class="err">No stock called ${esc(ticker)} here. <a href="#now">Back to the list</a></p>`; return; }

    const open = marketOpen();
    const trap = st.rt && st.rt.loss >= TRAP;
    const ref = c ? (c.ah ?? c.close) : null;
    const gap = st.dex != null && ref ? (st.dex / ref - 1) * 100 : null;
    const [label, col] = gap == null || trap ? ['no real market', 'var(--red)'] : verdict(gap);
    const n = nextOpen();

    const options = TOKENS.filter((t) => sd.items[t.s] && sd.items[t.s].dex != null)
      .map((t) => t.s.replace(/c$/, '')).sort()
      .map((tk) => `<option value="${tk}"${tk === ticker ? ' selected' : ''}>${tk}${coOf(tk + 'c') ? ' · ' + esc(coOf(tk + 'c')) : ''}</option>`).join('');

    let tonight;
    if (trap) {
      tonight = `<p class="bad">No real market on Base: buy $1,000 and sell it back, and you lose ${st.rt.loss.toFixed(0)}%. The price here means nothing, so there is no gap to judge.</p>`;
    } else {
      tonight = `<div class="tonight">
        <div class="cell"><span>${c ? nyParts(new Date(c.closeAt * 1000)).wd.toUpperCase() + ' CLOSE' : 'LAST CLOSE'}</span><b>${c ? money(c.close) : '–'}</b></div>
        <div class="cell"><span>AFTER-HOURS</span><b>${c && c.ah != null ? money(c.ah) : '–'}</b></div>
        <div class="cell"><span>BASE NOW</span><b>${money(st.dex)}</b></div>
        <div class="cell"><span>GAP TO LAST TRADE</span><b style="color:${col}">${gap == null ? '–' : pct(gap)}</b></div></div>
        <p>${open ? 'Wall Street is open, so the price on Base tracks the exchange and this gap is mostly noise.'
          : gap == null ? '' : Math.abs(gap) < QUIET ? `On Base, ${ticker} sits right at its last real trade.`
          : `On Base, ${ticker} costs ${Math.abs(gap).toFixed(1)}% ${gap > 0 ? 'more' : 'less'} than its last real trade. Wall Street opens ${n ? utcTime(n) : 'next weekday'} — then we see who was right.`}</p>`;
    }

    view.innerHTML = `<div class="head"><h1>${ticker}</h1><div class="co">${coOf(sym) ? esc(coOf(sym)) + ' · ' : ''}${sym} on Base</div>
      <span class="pill" style="border-color:${col};color:${col}">${label}${gap != null && !trap ? ' ' + pct(gap) : ''}</span>
      <span class="acts"><button class="b buy" data-trade="buy" data-sym="${sym}">Buy</button><button class="b sell" data-trade="sell" data-sym="${sym}">Sell</button></span>
      <select class="pick" id="pick" aria-label="Switch stock">${options}</select></div>
      <div class="grid"><div class="main">
        <div class="card"><h3>${open ? 'Right now' : 'Tonight'}</h3>${tonight}</div>
        <div class="card" id="weekends"><h3>Past weekends on Base</h3><p>Reading the weekend record…</p></div>
      </div><div class="side">
        <div class="card"><h3>What a trade costs</h3>
          <div class="kv"><span>$1,000 in and straight out</span><b>${st.rt ? '−' + st.rt.loss.toFixed(2) + '%' : '–'}</b></div>
          ${st.rt && st.rt.venues && st.rt.venues.length ? `<div class="kv"><span>Best route now</span><b>${esc(venueName(st.rt.venues[0]))}</b></div>` : ''}
          <p>Live quotes across every pool on Base. Under 1% means a real market.</p></div>
        <div class="card"><h3>Is it the real one?</h3><p class="green">✓ Official ${sym}, issued by Coinbase.</p>
          <p>Address <a href="${SCAN}${addr}" target="_blank" rel="noopener">${addr.slice(0, 6)}…${addr.slice(-4)}</a>, the same as on base.org/stocks. Fakes use the same ticker — go by the address.</p></div>
        <div class="card"><h3>What you own</h3><p>A claim on one real ${esc(CO[sym] || ticker)} share held 1:1 by Alpaca. Today 1 token = ${st.chain && st.chain.multiplier ? st.chain.multiplier.toFixed(4) : '–'} share. No vote; not sold to US persons.</p></div>
        <div class="card"><h3>Borrow against it</h3>${lendingHtml(st, sym)}</div>
        <a class="go" href="https://deftools.xyz/stocks.html" target="_blank" rel="noopener">Full check in Stock Check →</a>
      </div></div>`;
    $('pick').onchange = (e) => { location.hash = 'stock/' + e.target.value; };

    const runs = await loadWeekends();
    if (location.hash !== '#stock/' + ticker) return; // moved on while the log loaded
    const rows = runs.map((r) => weekendRow(r, sym)).filter(Boolean).reverse().slice(0, 5);
    // The weekend in progress: there has been a close since the last recorded open, and the market is still shut.
    const lastTo = rows.length ? rows[0].to : 0;
    const live = !open && c && c.closeAt > lastTo && !trap;
    const verdictCell = (r) => {
      if (r.worst > THIN_RT) return `<td class="dim">no<span class="wide"> real</span> market<span class="wide">${isFinite(r.worst) ? ` (−${r.worst.toFixed(0)}% round trip)` : ''}</span></td>`;
      if (Math.abs(r.night) < QUIET) return '<td class="dim"><span class="wide">stayed </span>flat</td>';
      return Math.sign(r.night) === Math.sign(r.open)
        ? `<td class="green">✓<span class="wide"> ${r.night > 0 ? 'up' : 'down'}, and it was</span></td>`
        : `<td class="bad">✗<span class="wide"> said ${r.night > 0 ? 'up' : 'down'}, went ${r.open > 0 ? 'up' : 'down'}</span></td>`;
    };
    const called = rows.filter((r) => r.worst <= THIN_RT && Math.abs(r.night) >= QUIET);
    const right = called.filter((r) => Math.sign(r.night) === Math.sign(r.open)).length;
    const box = $('weekends');
    if (!rows.length && !live) { box.innerHTML = '<h3>Past weekends on Base</h3><p>No weekend on record for this stock yet.</p>'; return; }
    box.innerHTML = `<h3>Past weekends on Base</h3><table><tr><th>WEEKEND</th><th class="n wide">FRI CLOSE</th><th class="n">BASE<span class="wide"> BEFORE OPEN</span></th><th class="n">US<span class="wide"> AFTER OPEN</span></th><th><span class="wide">NIGHT CALLED IT?</span><span class="nar">RIGHT?</span></th></tr>`
      + (live ? `<tr><td>${nyDay(c.closeAt)} – now</td><td class="n wide">${money(c.close)}</td><td class="n"><span class="wk-p">${money(st.dex)} </span><span class="dim">${pct((st.dex / c.close - 1) * 100)}</span></td><td class="n dim"><span class="wide">${n ? utcTime(n) : '–'}</span><span class="nar">at open</span></td><td class="dim">waiting</td></tr>` : '')
      + rows.map((r) => `<tr><td>${nyDay(r.from)} – ${nyDay(r.to)}</td><td class="n wide">${money(r.close)}</td><td class="n">${r.worst > THIN_RT ? '<span class="dim">not a price</span>' : `<span class="wk-p">${money(r.base)} </span><span class="dim">${pct(r.night)}</span>`}</td><td class="n"><span class="wk-p">${money(r.monday)} </span><span class="dim">${pct(r.open)}</span></td>${verdictCell(r)}</tr>`).join('')
      + `</table><p>${called.length ? `Night pointed the right way <b style="color:var(--fg)">${right} of ${called.length}</b> time${called.length > 1 ? 's' : ''} when it moved ${QUIET}% or more.` : 'No weekend with a real market moved it 0.5% or more.'} A premium at night is a bet, not a forecast.</p>`
      + '<p class="fine">Base before open = the last price logged before the bell, counted only if a $1,000 round trip cost under 2% right then; US after open = about 10 minutes in. From Stock Check\'s price log, every ~4 hours over the weekend.</p>';
  }

  window.NightStock = { render, loadWeekends, weekendRow };
})();
