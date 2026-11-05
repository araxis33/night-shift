/* Night Shift — the "Beat the night" tab.
   Every weekend: five stocks, higher or lower at Monday's open than their last real trade
   (after-hours included). The night plays too: its call is where the Base price sits about
   20 minutes before the open — the same record as the Monday check.
   Play needs nothing: picks stay in this browser. The leaderboard needs one signed message
   (free, no transaction); the Worker (base-tools check-worker/game.js) checks it and scores
   everyone from data/checks/<date>.json after the open.
   Uses the page's helpers: $, pct, utc, utcTime, getJSON, DATA. */
(function () {
  'use strict';
  const API = 'https://deftools-check.araxis67.workers.dev/game';
  const STORE = 'ns-game';
  const SITE = 'https://night.deftools.xyz/#game';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const load = () => { try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch (e) { return {}; } };
  const save = (s) => { try { localStorage.setItem(STORE, JSON.stringify(s)); } catch (e) { /* private mode */ } };
  const arrow = (p) => (p === 'higher' ? '<b class="up">▲ higher</b>' : p === 'lower' ? '<b class="dn">▼ lower</b>' : '<span class="dim">no call</span>');

  // The exact text signed for the board. Keep equal to pickMessage() in check-worker/game.js.
  const message = (date, tickers, picks) => ['Night Shift · Beat the night', `Round: ${date}`, ...tickers.map((t) => `${t}: ${picks[t]}`), 'No transaction, no gas.'].join('\n');

  let st = { index: null, round: null, check: null, prev: null, prevCheck: null, tab: 'week', busy: false, msg: '', timer: null };

  const outcome = (i) => (!i || i.open == null || i.ref == null || i.open === i.ref ? null : i.open > i.ref ? 'higher' : 'lower');
  const nightCall = (i) => (!i || i.base == null || i.base === i.ref ? null : i.base > i.ref ? 'higher' : 'lower');
  function tally(round, check, picks) {
    let right = 0, n = 0;
    for (const s of round.stocks) { const o = outcome(check.items[s.ticker]); if (!o) continue; n++; if (picks[s.ticker] === o) right++; }
    return { right, n };
  }
  const nightPicks = (round, check) => Object.fromEntries(round.stocks.map((s) => [s.ticker, nightCall(check.items[s.ticker])]));

  function left(sec) {
    if (sec <= 0) return 'now';
    const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
    return (d ? d + 'd ' : '') + (d || h ? h + 'h ' : '') + m + 'm';
  }

  async function fetchAll() {
    try { st.index = await getJSON('data/game/index.json'); } catch (e) { st.index = []; }
    const get = async (p) => { try { return await getJSON(p); } catch (e) { return null; } };
    const [d0, d1] = st.index;
    st.round = d0 ? await get(`data/game/${d0}.json`) : null;
    st.check = d0 ? await get(`data/checks/${d0}.json`) : null;
    st.prev = d1 ? await get(`data/game/${d1}.json`) : null;
    st.prevCheck = d1 ? await get(`data/checks/${d1}.json`) : null;
  }

  const phase = () => {
    if (!st.round) return 'none';
    if (Date.now() / 1000 < st.round.lockAt) return 'open';
    return st.check && st.check.openAt ? 'result' : 'locked';
  };

  // Base now vs the last real trade, for the live "night says" before the lock.
  async function liveNight() {
    const out = {};
    try {
      const [sd] = await DATA;
      for (const s of st.round.stocks) {
        const dex = sd.items[s.ticker + 'c']?.dex;
        if (dex != null) out[s.ticker] = (dex / s.ref - 1) * 100;
      }
    } catch (e) { /* prices did not load: the rows say so */ }
    return out;
  }

  function nightSays(g) {
    if (g == null) return '<span class="dim">no Base price yet</span>';
    if (Math.abs(g) < 0.05) return `Night says <span class="dim">flat</span> · Base ${pct(g)}`;
    return `Night says ${arrow(g > 0 ? 'higher' : 'lower')} · Base ${pct(g)}`;
  }

  async function renderMain() {
    const me = load(), p = phase(), box = $('gmMain');
    if (p === 'none') {
      box.innerHTML = `<div class="gm-empty"><h3>The first round opens this weekend</h3><p>Right after Friday's after-hours end (about 01:20 UTC on Saturday), five stocks show up here. Pick higher or lower for each before Monday 14:25 UTC.</p></div>`;
      return;
    }
    const r = st.round, mine = me[r.date] || { picks: {} };
    const lockAt = new Date(r.lockAt * 1000);
    if (p === 'open') {
      const g = await liveNight();
      const picked = r.stocks.filter((s) => mine.picks[s.ticker]).length;
      const signed = mine.addr && mine.signed && r.stocks.every((s) => mine.signed[s.ticker] === mine.picks[s.ticker]);
      box.innerHTML = `<div class="gm-lock"><span>This week: the 5 stocks that moved most in Friday's after-hours, all cheap to trade on Base</span><span>Picks lock in <b id="gmLeft">${left(r.lockAt - Date.now() / 1000)}</b> · ${utcTime(lockAt)}</span></div>`
        + r.stocks.map((s) => `<div class="gm-row"><div class="gm-tk">${esc(s.ticker)}<span>${esc(s.name)}</span></div><div class="gm-night">${nightSays(g[s.ticker])}</div>`
          + `<div class="gm-pick"><button class="gm-p hi${mine.picks[s.ticker] === 'higher' ? ' on' : ''}" data-gpick="${esc(s.ticker)}" data-dir="higher">▲ Higher</button><button class="gm-p lo${mine.picks[s.ticker] === 'lower' ? ' on' : ''}" data-gpick="${esc(s.ticker)}" data-dir="lower">▼ Lower</button></div></div>`).join('')
        + `<div class="gm-done"><span>${picked} of 5 picked · saved in this browser, change until the lock${signed ? ` · <b class="green">on the board as ${esc(mine.name)}</b>` : ''}</span>`
        + `<button class="gm-cta" id="gmSign"${picked < 5 || st.busy ? ' disabled' : ''}>${signed ? 'On the board ✓' : mine.addr ? 'Update my board picks' : 'Join the leaderboard'}</button></div>`
        + (st.msg ? `<div class="gm-msg">${st.msg}</div>` : '')
        + `<div class="gm-how">Higher or lower = Monday's open against the last real trade (Friday after-hours). The night's call is the Base price about 20 minutes before the open.</div>`;
      return;
    }
    const check = st.check;
    const np = check ? nightPicks(r, check) : {};
    if (p === 'locked') {
      box.innerHTML = `<div class="gm-lock"><span>Picks are locked</span><span>Scores land after the 14:30 UTC open, around 15:00 UTC</span></div>`
        + r.stocks.map((s) => `<div class="gm-row"><div class="gm-tk">${esc(s.ticker)}<span>${esc(s.name)}</span></div><div class="gm-night">You: ${arrow(mine.picks[s.ticker])}</div><div class="gm-night">${check ? 'Night: ' + arrow(np[s.ticker]) : ''}</div></div>`).join('');
      return;
    }
    const you = tally(r, check, mine.picks), night = tally(r, check, np);
    const played = Object.keys(mine.picks).length > 0;
    const line = !played ? `The night got <b>${night.right}/${night.n}</b>. You did not play this round.`
      : you.right > night.right ? `You got <b>${you.right}/${you.n}</b>, the night <b>${night.right}/${night.n}</b>. You beat the night.`
      : you.right === night.right ? `You got <b>${you.right}/${you.n}</b>, the night too. A draw.`
      : `You got <b>${you.right}/${you.n}</b>, the night <b>${night.right}/${night.n}</b>. The night wins this one.`;
    const share = played ? `https://x.com/intent/post?text=${encodeURIComponent(`I called Monday's open on ${you.right} of ${you.n} stocks. The night on Base got ${night.right}/${night.n}. Can you beat it?\n\n${SITE}`)}` : '';
    box.innerHTML = `<div class="gm-lock"><span>Results · ${esc(new Date(r.date + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }))}</span><span>Next round opens Saturday, about 01:20 UTC</span></div>`
      + `<div class="gm-score">${line}${share ? ` <a class="gm-share" href="${share}" target="_blank" rel="noopener">Share on X</a>` : ''}</div>`
      + `<table class="gm-res"><tr><th>STOCK</th><th class="n">OPEN</th><th>YOU</th><th>NIGHT</th></tr>`
      + r.stocks.map((s) => {
        const i = check.items[s.ticker], o = outcome(i);
        const mark = (pk) => (!pk || !o ? '' : pk === o ? ' <b class="up">✓</b>' : ' <b class="dn">✗</b>');
        return `<tr><td><b>${esc(s.ticker)}</b></td><td class="n">${i && i.open != null ? pct((i.open / i.ref - 1) * 100) : '<span class="dim">no open</span>'}</td><td>${arrow(mine.picks[s.ticker])}${mark(mine.picks[s.ticker])}</td><td>${arrow(np[s.ticker])}${mark(np[s.ticker])}</td></tr>`;
      }).join('') + '</table>';
  }

  async function renderBoard() {
    const el = $('gmBoard'), me = load();
    const myAddr = Object.values(me).map((x) => x.addr).find(Boolean);
    const seg = `<div class="gm-seg"><button class="${st.tab === 'week' ? 'on' : ''}" data-gtab="week">This week</button><button class="${st.tab === 'all' ? 'on' : ''}" data-gtab="all">All time</button></div>`;
    if (!st.round) { el.innerHTML = `<h3>Leaderboard</h3>${seg}<p class="dim">Opens with the first round.</p>`; return; }
    let rows = '';
    try {
      if (st.tab === 'week') {
        const b = await (await fetch(`${API}/board?date=${st.round.date}`)).json();
        if (b.error) throw new Error(b.error);
        const list = b.players.map((x) => ({ ...x, me: x.addr === myAddr }));
        if (b.scored) {
          const night = { name: '🌙 The night', right: b.night.right, n: b.night.n, night: true };
          const pos = list.findIndex((x) => x.right < night.right);
          list.splice(pos < 0 ? list.length : pos, 0, night);
          let rank = 0;
          rows = list.slice(0, 12).map((x) => `<tr class="${x.night ? 'night' : x.me ? 'me' : ''}"><td>${x.night ? '–' : ++rank}</td><td>${esc(x.me ? x.name + ' (you)' : x.name)}</td><td class="n">${x.right}/${x.n}</td></tr>`).join('');
        } else {
          rows = list.length ? list.slice(0, 12).map((x) => `<tr class="${x.me ? 'me' : ''}"><td>·</td><td>${esc(x.me ? x.name + ' (you)' : x.name)}</td><td class="n dim">in</td></tr>`).join('')
            + `<tr class="night"><td>–</td><td>🌙 The night</td><td class="n">in</td></tr>` : '';
          rows = `<tr><td colspan="3" class="dim">${b.players.length} on the board this week. Scores after Monday's open.</td></tr>` + rows;
        }
      } else {
        const b = await (await fetch(`${API}/alltime`)).json();
        rows = b.players.length ? b.players.slice(0, 12).map((x, i) => `<tr class="${x.addr === myAddr ? 'me' : ''}"><td>${i + 1}</td><td>${esc(x.name)}</td><td class="n">${x.right}/${x.n}</td></tr>`).join('')
          : '<tr><td colspan="3" class="dim">No scored rounds yet.</td></tr>';
      }
    } catch (e) { rows = '<tr><td colspan="3" class="dim">The leaderboard did not load. Try again in a minute.</td></tr>'; }
    el.innerHTML = `<h3>Leaderboard</h3>${seg}<table class="gm-board">${rows}</table>`
      + `<div class="gm-join"><b>Get on the board</b>Sign once with your wallet. Free, no transaction, no gas. One wallet, one spot. Your .base.eth name shows if you have one.</div>`;
  }

  function renderLast() {
    const el = $('gmLast'), me = load();
    const r = st.prev, c = st.prevCheck;
    if (phase() === 'result' || !r || !c || !c.openAt) { el.hidden = true; return; }
    const mine = me[r.date] && me[r.date].picks;
    const night = tally(r, c, nightPicks(r, c));
    el.hidden = false;
    if (!mine || !Object.keys(mine).length) { el.innerHTML = `<h3>Last Monday</h3><p>The night got <b>${night.right}/${night.n}</b>.</p>`; return; }
    const you = tally(r, c, mine);
    el.innerHTML = `<h3>Last Monday</h3><div class="gm-big">${you.right}/${you.n}</div><p>you · <b>${night.right}/${night.n}</b> the night. ${you.right > night.right ? 'You beat the night.' : you.right === night.right ? 'A draw.' : 'The night won.'}</p>`;
  }

  async function sign() {
    const p = window.ethereum;
    if (!p) { st.msg = 'No wallet in this browser. You can still play: your picks are saved here.'; return renderMain(); }
    const r = st.round, me = load(), mine = me[r.date];
    const tickers = r.stocks.map((s) => s.ticker);
    st.busy = true; st.msg = 'Confirm the message in your wallet. It is a signature, not a transaction.'; await renderMain();
    try {
      const [address] = await p.request({ method: 'eth_requestAccounts' });
      const text = message(r.date, tickers, mine.picks);
      const hex = '0x' + Array.from(new TextEncoder().encode(text), (b) => b.toString(16).padStart(2, '0')).join('');
      const signature = await p.request({ method: 'personal_sign', params: [hex, address] });
      const res = await fetch(`${API}/pick`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ date: r.date, address, picks: mine.picks, signature }) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || 'not saved');
      Object.assign(mine, { addr: address.toLowerCase(), name: j.name, signed: { ...mine.picks } });
      save(me);
      st.msg = '';
    } catch (e) {
      st.msg = /reject|denied/i.test(e.message || '') ? 'Signature cancelled. Your picks are still saved in this browser.' : 'Not saved to the board: ' + esc(e.message || e);
    }
    st.busy = false;
    await renderMain(); renderBoard();
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-gpick]');
    if (b && phase() === 'open') {
      const me = load(), d = st.round.date;
      me[d] = me[d] || { picks: {} };
      me[d].picks[b.dataset.gpick] = b.dataset.dir;
      save(me); st.msg = ''; renderMain();
      return;
    }
    if (e.target.id === 'gmSign' && !st.busy) { sign(); return; }
    const t = e.target.closest('[data-gtab]');
    if (t) { st.tab = t.dataset.gtab; renderBoard(); }
  });

  async function render() {
    if (!st.index) await fetchAll();
    await renderMain(); renderBoard(); renderLast();
    clearInterval(st.timer);
    st.timer = setInterval(() => {
      if (document.getElementById('viewGame').hidden) return;
      const l = $('gmLeft');
      if (phase() !== 'open') { clearInterval(st.timer); renderMain(); return; }
      if (l) l.textContent = left(st.round.lockAt - Date.now() / 1000);
    }, 30000);
  }

  window.NightGame = { render };
})();
