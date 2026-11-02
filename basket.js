/* Night Shift — the Basket tab: buy an idea tonight.
   One line of what you believe becomes a basket of Coinbase stocks on Base,
   matched by deftools' Thesis code (ThesisCore.parseThesis), and each stock in
   it is set against its last real trade, so the page can say what the basket
   costs tonight compared with the last close and after-hours. Buying is
   Thesis' flow: every swap quoted by KyberSwap, batched into one confirmation
   when the wallet can (EIP-5792), one at a time when it cannot.
   Uses the page's helpers: $, money, pct, verdict, DATA, TRAP, QUIET. */
(function () {
  'use strict';
  const KYBER = 'https://aggregator-api.kyberswap.com/base/api/v1';
  const RPC = 'https://mainnet.base.org';
  const CHAIN_HEX = '0x2105';
  const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
  const BUILDER_SUFFIX = '62635f6d726b7775326d300b0080218021802180218021802180218021';
  const SLIPPAGE_BPS = 100;
  const FEE_BPS = 10; // 0.1% to this site, inside every quote
  const FEE_WALLET = '0x2ab08a231389fD6c1cb368769aE5Ba3f999209e4';
  const QUOTE_LIMIT = 3; // % a live route may cost beyond the Base price before the stock is left out
  const PRICEY = 2;      // the page's own verdict line
  const REJECTED_RE = /user rejected|denied/i;
  const TOKENS = (window.ThesisCore && ThesisCore.TOKENS) || [];
  const BY_S = Object.fromEntries(TOKENS.map((t) => [t.s, t]));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const hex32 = (n) => BigInt(n).toString(16).padStart(64, '0');

  const st = { text: 'ai chips and cloud, no tesla', amount: 1000, pay: 'USDC', mode: 'all', parsed: null, sd: null, cl: null };
  let ex = { state: 'idle', account: null, quotes: null, msg: '', link: '', error: null, busy: false };

  // ---------------------------------------------------------------- the basket
  function candidates() {
    if (!st.parsed || !st.sd) return { rows: [], left: [] };
    const rows = [], left = [];
    for (const [s, w] of Object.entries(st.parsed.weights || {})) {
      const v = st.sd.items[s], t = BY_S[s], c = st.cl.items[s.replace(/c$/, '')];
      if (!v || !t || w <= 0) continue;
      if (v.dex == null || !v.rt || v.rt.loss >= TRAP) { left.push({ s, loss: v.rt ? v.rt.loss : null }); continue; }
      const ref = c ? (c.ah ?? c.close) : null;
      rows.push({ s, t, w, dex: v.dex, ref, gap: ref ? (v.dex / ref - 1) * 100 : null, rt: v.rt.loss });
    }
    return { rows, left };
  }
  // The toggle: keep everything, skip what costs 2% or more over its last trade, or keep only the fair ones.
  function inMode(r) {
    if (st.mode === 'all' || r.gap == null) return true;
    const g = Math.round(r.gap * 10) / 10;
    return st.mode === 'skip' ? g < PRICEY : Math.abs(g) < PRICEY;
  }
  function basket() {
    const { rows, left } = candidates();
    const kept = rows.filter(inMode), skipped = rows.filter((r) => !inMode(r));
    const tot = kept.reduce((a, r) => a + r.w, 0);
    kept.forEach((r) => { r.share = r.w / tot; r.usd = st.amount * r.share; r.qty = r.usd / r.dex; });
    kept.sort((a, b) => b.share - a.share || Math.abs(b.gap || 0) - Math.abs(a.gap || 0));
    return { kept, skipped, left };
  }

  // ---------------------------------------------------------------- drawing
  function render() {
    const v = $('viewBasket');
    if (!v.dataset.built) {
      v.dataset.built = '1';
      v.innerHTML = `<h1>Buy an idea tonight</h1><div class="sub">Write what you believe. Get a basket of real Coinbase stocks on Base — and see which of them cost more tonight than at their last real trade.</div>
      <div class="grid"><div class="main">
        <div class="card"><div class="row"><input class="in" id="bkText" autocomplete="off" spellcheck="false" placeholder="ai chips and cloud, no tesla"><button class="btn" id="bkGo">Build basket</button></div>
          <div class="row" style="margin-top:10px"><span id="bkChips" class="chips"></span><span class="amtline">I put in <span class="amtbox">$<input id="bkAmt" inputmode="decimal" value="1,000"></span>
          <select id="bkPay" aria-label="Pay with"><option>USDC</option><option>ETH</option></select></span></div></div>
        <div class="card" id="bkList"><p>Reading prices…</p></div>
      </div><div class="side">
        <div class="card" id="bkPrem"></div>
        <div class="card" id="bkBuy"></div>
        <div class="card" id="bkWeek"><h3>Last weekend</h3><p>Reading the weekend record…</p></div>
      </div></div>`;
      $('bkText').value = st.text;
      $('bkGo').onclick = build;
      $('bkText').onkeydown = (e) => { if (e.key === 'Enter') build(); };
      $('bkAmt').oninput = () => { const n = Number($('bkAmt').value.replace(/[^0-9.]/g, '')); if (n > 0) { st.amount = n; resetBuy(); draw(); } };
      $('bkPay').onchange = () => { st.pay = $('bkPay').value; resetBuy(); draw(); };
      DATA.then(([sd, cl]) => { st.sd = sd; st.cl = cl; build(); }).catch(() => { $('bkList').innerHTML = '<p class="bad">Prices did not load. Try again in a minute.</p>'; });
    }
  }

  function build() {
    st.text = $('bkText').value.trim() || st.text;
    st.parsed = ThesisCore.parseThesis(st.text);
    resetBuy();
    draw();
  }
  function resetBuy() { ex = { state: 'idle', account: ex.account, quotes: null, msg: '', link: '', error: null, busy: false }; }

  function draw() {
    if (!st.parsed || !st.sd) return;
    const p = st.parsed;
    $('bkChips').innerHTML = p.why.map((w) => `<span class="chip">${esc(w)}</span>`).join('') + (p.dropped || []).map((s) => `<span class="chip x">${esc(s.replace(/c$/, ''))}</span>`).join('');
    const { kept, skipped, left } = basket();
    if (!kept.length) {
      $('bkList').innerHTML = `<h3>Your basket</h3><p>${p.weights && Object.keys(p.weights).length ? 'Nothing left in the basket with this filter.' : 'No stock matched that. Try a company, a ticker or a theme: ai, chips, cloud, games, space, bitcoin…'}</p>`;
      $('bkPrem').innerHTML = ''; $('bkBuy').innerHTML = ''; $('bkPrem').hidden = $('bkBuy').hidden = true;
      return;
    }
    $('bkPrem').hidden = $('bkBuy').hidden = false;
    const shown = kept.length <= 8 ? kept : kept.slice(0, 7), rest = kept.slice(shown.length);
    const maxShare = Math.max(...kept.map((r) => r.share));
    const row = (r) => {
      const [label, col] = r.gap == null ? ['–', '#7d8a97'] : verdict(r.gap);
      return `<tr><td><a class="tk" href="#stock/${r.s.replace(/c$/, '')}"><b>${r.s.replace(/c$/, '')}</b></a></td><td><span class="bar"><i style="width:${(r.share / maxShare * 100).toFixed(0)}%"></i></span>${(r.share * 100).toFixed(1)}%</td>
        <td class="n">${money(r.dex)}</td><td class="n" style="color:${label === 'fair' ? 'inherit' : col};font-weight:${label === 'fair' ? 400 : 700}">${r.gap == null ? '–' : pct(r.gap)}</td>
        <td class="vp"><span class="pill" style="color:${col};border-color:${col}">${label}</span></td><td class="n wide">${r.qty.toFixed(4)}</td></tr>`;
    };
    $('bkList').innerHTML = `<h3>Your basket · ${kept.length} stock${kept.length > 1 ? 's' : ''}</h3>
      <table><tr><th>STOCK</th><th>WEIGHT</th><th class="n">BASE NOW</th><th class="n">GAP<span class="wide"> TONIGHT</span></th><th class="vp"></th><th class="n wide">YOU GET</th></tr>
      ${shown.map(row).join('')}
      ${rest.length ? `<tr><td class="dim" colspan="6" style="white-space:normal">+ ${rest.map((r) => r.s.replace(/c$/, '')).join(', ')} at ${(rest[0].share * 100).toFixed(1)}%${rest.every((r) => r.share === rest[0].share) ? ' each' : ' or less'}, ${rest.every((r) => Math.abs(r.gap || 0) < 1) ? 'all within ±1%' : 'gaps ' + rest.map((r) => pct(r.gap || 0)).join(', ')}</td></tr>` : ''}
      </table>
      ${skipped.length ? `<p>Skipped by the filter: ${skipped.map((r) => r.s.replace(/c$/, '') + ' ' + pct(r.gap)).join(', ')}.</p>` : ''}
      ${left.length ? `<p>${left.map((l) => esc(BY_S[l.s] ? BY_S[l.s].co : l.s)).join(', ')} matched but ${left.length > 1 ? 'are' : 'is'} left out: buy $1,000 and sell it back on Base and you lose ${l0(left)}.</p>` : ''}`;

    // Tonight's premium: what the money buys, valued at each stock's last real trade.
    const priced = kept.filter((r) => r.ref);
    const atRef = priced.reduce((a, r) => a + r.qty * r.ref, 0), spent = priced.reduce((a, r) => a + r.usd, 0);
    const prem = atRef ? (spent / atRef - 1) * 100 : null;
    const over = kept.filter((r) => r.gap != null && Math.round(r.gap * 10) / 10 >= PRICEY), under = kept.filter((r) => r.gap != null && Math.round(r.gap * 10) / 10 <= -PRICEY);
    const names = (a) => a.map((r) => `${r.s.replace(/c$/, '')} (${pct(r.gap)})`).join(', ');
    let why = '';
    if (over.length && under.length) why = `Paying over on ${names(over)} is ${Math.abs(prem) < QUIET ? 'cancelled out' : 'partly offset'} by buying ${names(under)} under their last trade.`;
    else if (over.length) why = `Most of it is ${names(over)}.`;
    else if (under.length) why = `${names(under)} ${under.length > 1 ? 'cost' : 'costs'} less than at the last trade.`;
    else why = 'Every stock in it sits within 2% of its last trade.';
    $('bkPrem').innerHTML = `<h3>Tonight's premium</h3><div class="big" style="color:${prem >= PRICEY ? 'var(--amber)' : prem <= -PRICEY ? 'var(--green)' : 'var(--fg)'}">${prem == null ? '–' : (prem > 0 ? '+' : prem < 0 ? '−' : '') + Math.abs(prem).toFixed(2) + '%'}</div>
      <p>Your ${money(spent).replace(/\.00$/, '')} buys stock worth <b style="color:var(--fg)">${money(atRef)}</b> at the last real trades. ${why}</p>
      ${marketOpen() ? '<p>Wall Street is open, so these gaps are mostly noise right now.</p>' : ''}
      <div class="toggle">${[['all', 'Keep all'], ['skip', 'Skip pricey'], ['fair', 'Only fair']].map(([m, l]) => `<button type="button" data-mode="${m}" class="${st.mode === m ? 'on' : ''}">${l}</button>`).join('')}</div>`;
    $('bkPrem').querySelectorAll('[data-mode]').forEach((b) => { b.onclick = () => { st.mode = b.dataset.mode; resetBuy(); draw(); }; });

    drawBuy(kept);
    drawWeekend(kept);
  }
  function l0(left) {
    const known = left.filter((l) => l.loss != null).map((l) => l.loss);
    if (!known.length) return 'most of it';
    const lo = Math.floor(Math.min(...known)), hi = Math.floor(Math.max(...known));
    return lo === hi ? hi + '%' : lo + '–' + hi + '%';
  }

  function drawBuy(kept) {
    const est = kept.reduce((a, r) => a + r.share * r.rt, 0) / 2; // one way ≈ half the round trip
    let h = `<h3>Buy it</h3>
      <div class="kv"><span>${kept.length} swap${kept.length > 1 ? 's' : ''}, one confirmation</span><b>${st.pay}</b></div>
      <div class="kv"><span>Lost to fees and price impact</span><b>≈ ${est.toFixed(2)}%</b></div>
      <div class="kv"><span>Fee to this site</span><b>${FEE_BPS / 100}%</b></div>`;
    if (ex.error) h += `<p class="bad">${esc(ex.error)}</p>`;
    if (ex.quotes) {
      const spent = ex.quotes.reduce((a, q) => a + q.row.usd, 0);
      const worth = ex.quotes.reduce((a, q) => a + Number(q.out) / 1e8 * q.row.dex, 0);
      h += `<div class="kv"><span>Live quote: ${money(spent)} buys</span><b>${money(worth)}</b></div><p>at the Base prices above, ${ex.quotes.length} stock${ex.quotes.length > 1 ? 's' : ''}, slippage limit 1%.</p>`;
    }
    const btn = { idle: [ex.account ? 'Get live quotes' : 'Connect wallet', 'bkQuote', false], quoting: [`Quoting ${kept.length} swaps…`, '', true],
      ready: [`Buy ${ex.quotes ? ex.quotes.length : kept.length} stocks in one go`, 'bkDo', false], sending: ['Confirm in your wallet…', '', true], done: ['Start again', 'bkAgain', false] }[ex.state];
    h += `<button class="cta" id="${btn[1]}" ${btn[2] ? 'disabled' : ''}>${btn[0]}</button>`;
    if (ex.state === 'done' && ex.link) h += `<a class="tr-link" href="${ex.link}" target="_blank" rel="noopener">See it onchain</a>`;
    if (ex.msg) h += `<p class="${ex.state === 'done' ? 'green' : ''}">${esc(ex.msg)}</p>`;
    h += `<p>Routed by KyberSwap across every pool on Base, signed in your own wallet. ${st.pay === 'ETH' ? 'Paid in ETH: no allowance at all.' : 'The allowance is exactly the size of this basket.'}</p>`;
    $('bkBuy').innerHTML = h;
    if ($('bkQuote')) $('bkQuote').onclick = () => doQuote(kept);
    if ($('bkDo')) $('bkDo').onclick = doBuy;
    if ($('bkAgain')) $('bkAgain').onclick = () => { resetBuy(); draw(); };
  }

  async function drawWeekend(kept) {
    const runs = await NightStock.loadWeekends();
    const box = $('bkWeek');
    const run = runs[runs.length - 1];
    if (!run) { box.innerHTML = '<h3>Last weekend</h3><p>No weekend on record yet.</p>'; return; }
    let called = 0, right = 0;
    for (const r of kept) {
      const w = NightStock.weekendRow(run, r.s);
      if (!w || w.worst > 2 || Math.abs(w.night) < QUIET) continue;
      called++; if (Math.sign(w.night) === Math.sign(w.open)) right++;
    }
    const day = (ts) => new Date(ts * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'America/New_York' });
    box.innerHTML = `<h3>Last weekend</h3><p>${day(run.snaps[0].t)} – ${day(run.after.t)}: ${called
      ? `for these stocks, the night pointed the right way <b style="color:var(--fg)">${right} of ${called}</b> time${called > 1 ? 's' : ''} it moved 0.5% or more.`
      : 'none of these stocks moved 0.5% or more on Base.'} A premium at night is a bet, not a forecast.</p>`;
  }

  // ---------------------------------------------------------------- buying (Thesis' flow)
  function provider() {
    const p = window.ethereum;
    if (!p) return null;
    if (p.providers && p.providers.length) return p.providers.find((x) => x.isCoinbaseWallet) || p.providers[0];
    return p;
  }
  async function rpc(method, params) {
    for (let i = 0; i < 5; i++) {
      try {
        const r = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
        if (!r.ok) throw new Error(r.status === 429 ? 'The public Base node is busy. Try again in a moment.' : 'The Base node answered ' + r.status + '.');
        const j = await r.json();
        if (j && j.error) throw new Error(j.error.message || 'The node refused that read.');
        return j ? j.result : null;
      } catch (e) { if (i === 4) throw e; await sleep(700 * (i + 1)); }
    }
  }
  const uintCall = async (to, data) => { const r = await rpc('eth_call', [{ to, data }, 'latest']); return r && r !== '0x' ? BigInt(r) : 0n; };
  const allowanceOf = (token, owner, spender) => uintCall(token, '0xdd62ed3e' + hex32(BigInt(owner)) + hex32(BigInt(spender)));
  const balanceOf = (token, owner) => uintCall(token, '0x70a08231' + hex32(BigInt(owner)));

  async function connect() {
    const p = provider();
    if (!p) throw new Error('No wallet found in this browser. Everything else on the page works without one.');
    const accs = await p.request({ method: 'eth_requestAccounts' });
    if (!accs || !accs.length) throw new Error('The wallet returned no account.');
    ex.account = accs[0];
    if ((await p.request({ method: 'eth_chainId' })) !== CHAIN_HEX) await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN_HEX }] });
    return accs[0];
  }
  async function ethPriceUsd() {
    const j = await (await fetch(`${KYBER}/routes?tokenIn=${NATIVE}&tokenOut=${USDC}&amountIn=1000000000000000000`)).json();
    if (!j || j.code !== 0 || !j.data) throw new Error('Could not price ETH right now. Try again, or pay in USDC.');
    return Number(j.data.routeSummary.amountOut) / 1e6;
  }
  async function route(row, from) {
    const eth = row.ethWei !== undefined;
    const fee = `&feeAmount=${FEE_BPS}&chargeFeeBy=currency_out&isInBps=true&feeReceiver=${FEE_WALLET}`;
    const j = await (await fetch(`${KYBER}/routes?tokenIn=${eth ? NATIVE : USDC}&tokenOut=${row.t.a}&amountIn=${(eth ? row.ethWei : row.wei).toString()}&gasInclude=true${fee}`)).json();
    if (!j || j.code !== 0 || !j.data) throw new Error(row.s + ': no route found');
    const b = await (await fetch(`${KYBER}/route/build`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ routeSummary: j.data.routeSummary, sender: from, recipient: from, slippageTolerance: SLIPPAGE_BPS, source: 'night.deftools.xyz' }) })).json();
    if (!b || b.code !== 0 || !b.data) throw new Error(row.s + ': could not build the swap');
    return { row, router: b.data.routerAddress, data: b.data.data, out: BigInt(b.data.amountOut), value: eth ? BigInt(b.data.transactionValue || row.ethWei) : 0n };
  }

  async function doQuote(kept) {
    if (ex.busy) return;
    ex.busy = true; ex.error = null; ex.msg = '';
    try {
      const from = await connect();
      ex.state = 'quoting'; draw();
      const rows = kept.filter((r) => r.usd >= 0.5).map((r) => ({ ...r, wei: BigInt(Math.round(r.usd * 1e6)) }));
      if (st.pay === 'ETH') { const px = await ethPriceUsd(); rows.forEach((r) => { r.ethWei = BigInt(Math.round(r.usd / px * 1e6)) * 10n ** 12n; }); }
      const qs = [];
      // One at a time with a pause, and one retry: KyberSwap refuses bursts (its refusal carries no CORS header, so it reads as "Failed to fetch").
      for (const r of rows) {
        await sleep(400);
        try { qs.push(await route(r, from)); } catch (e) { await sleep(2000); qs.push(await route(r, from)); }
      }
      // The executable quote has the last word: a stock whose live route costs more than QUOTE_LIMIT over its Base price stays out.
      const dropped = [];
      const ok = qs.filter((q) => {
        const got = Number(q.out) / 1e8, eff = got > 0 ? q.row.usd / got : Infinity, diff = (eff / q.row.dex - 1) * 100;
        if (diff > QUOTE_LIMIT) { dropped.push(`${q.row.s.replace(/c$/, '')} (${isFinite(diff) ? '+' + diff.toFixed(1) + '%' : 'no shares'})`); return false; }
        return true;
      });
      if (dropped.length) ex.error = `Left out after quoting: ${dropped.join(', ')} — the live route costs more than ${QUOTE_LIMIT}% over the Base price. That money stays in your ${st.pay}.`;
      ex.quotes = ok.length ? ok : null;
      ex.state = ok.length ? 'ready' : 'idle';
      ex.msg = ok.length ? 'Quotes are good for a couple of minutes.' : '';
    } catch (e) {
      ex.error = (REJECTED_RE.test(e.message || '') || e.code === 4001) ? 'Cancelled in the wallet.' : (e.message || String(e));
      ex.state = ex.quotes ? 'ready' : 'idle';
    }
    ex.busy = false; draw();
  }

  async function waitForReceipt(p, hash, what) {
    for (let i = 0; i < 90; i++) {
      let r = null;
      try { r = await rpc('eth_getTransactionReceipt', [hash]); } catch (e) { r = null; }
      if (!r && p) { try { r = await p.request({ method: 'eth_getTransactionReceipt', params: [hash] }); } catch (e) { r = null; } }
      if (r && r.blockNumber) { if (r.status === '0x0') throw new Error(`The ${what || 'transaction'} reverted onchain. Nothing left your wallet but gas.`); return r; }
      await sleep(2000);
    }
    throw new Error('Timed out waiting for the confirmation.');
  }
  async function signAndConfirm(p, tx, what, landed) {
    let stop = false;
    const sent = p.request({ method: 'eth_sendTransaction', params: [tx] }); sent.catch(() => {});
    const watch = async (seconds) => {
      const until = Date.now() + seconds * 1000;
      while (!stop && Date.now() < until && landed) { await sleep(3000); if (stop) return false; try { if (await landed()) return true; } catch (e) { /* keep watching */ } }
      return false;
    };
    let answer;
    try { answer = await Promise.race([sent, watch(240)]); }
    catch (err) { if (err && (err.code === 4001 || REJECTED_RE.test(err.message || ''))) throw new Error('Cancelled in the wallet.'); answer = await watch(45); }
    stop = true;
    if (typeof answer === 'string' && answer) { await waitForReceipt(p, answer, what); return answer; }
    if (answer === true) return null;
    throw new Error(`The wallet never came back on the ${what}. Nothing is stuck on this page — check the wallet, then try again.`);
  }
  // One confirmation when the wallet can batch (EIP-5792), otherwise one call at a time, each mined before the next.
  async function sendCalls(p, from, calls) {
    const plain = calls.map((c) => ({ to: c.to, data: c.data, value: c.value || '0x0' }));
    let res;
    try { res = await p.request({ method: 'wallet_sendCalls', params: [{ version: '2.0.0', chainId: CHAIN_HEX, from, atomicRequired: true, calls: plain }] }); }
    catch (e) {
      if (e && (e.code === 4001 || REJECTED_RE.test(e.message || ''))) throw new Error('Cancelled in the wallet.');
      ex.msg = 'This wallet cannot batch — sending the calls one at a time.'; draw();
      let last = null, n = 0;
      for (const c of calls) {
        ex.msg = `Confirm ${++n} of ${calls.length} in your wallet…`; draw();
        const h = await signAndConfirm(p, { from, to: c.to, data: c.data, value: c.value || '0x0' }, c.what || 'transaction', c.landed);
        if (h) last = h;
      }
      ex.state = 'done'; ex.link = last ? 'https://basescan.org/tx/' + last : 'https://basescan.org/address/' + from; ex.msg = `Done — ${calls.length} transactions.`;
      return;
    }
    const id = res && res.id ? res.id : res;
    ex.state = 'done'; ex.link = 'https://basescan.org/address/' + from; ex.msg = `Sent as one batch of ${calls.length} calls. Waiting for the receipt…`; draw();
    for (let i = 0; i < 40; i++) {
      try {
        const s = await p.request({ method: 'wallet_getCallsStatus', params: [id] });
        const rc = s && s.receipts && s.receipts[0];
        if (rc && rc.transactionHash) { ex.link = 'https://basescan.org/tx/' + rc.transactionHash; ex.msg = 'Confirmed onchain, one transaction.'; return; }
      } catch (e) { return; } // the wallet does not report status; the address link stands
      await sleep(2000);
    }
  }

  async function doBuy() {
    if (ex.busy || !ex.quotes) return;
    ex.busy = true; ex.error = null; ex.msg = ''; ex.state = 'sending'; draw();
    const p = provider(), from = ex.account;
    try {
      const before = Object.fromEntries(await Promise.all(ex.quotes.map(async (q) => [q.row.s, await balanceOf(q.row.t.a, from)])));
      const swap = (q) => ({ to: q.router, data: q.data + BUILDER_SUFFIX, value: '0x' + q.value.toString(16), what: 'swap',
        landed: async () => (await balanceOf(q.row.t.a, from)) > before[q.row.s] });
      let calls;
      if (ex.quotes[0].value > 0n) {
        const need = ex.quotes.reduce((a, q) => a + q.value, 0n), eth = BigInt(await rpc('eth_getBalance', [from, 'latest']));
        if (eth < need) throw new Error(`This wallet holds ${(Number(eth) / 1e18).toFixed(5)} ETH; the basket needs ${(Number(need) / 1e18).toFixed(5)} ETH plus gas.`);
        calls = ex.quotes.map(swap);
      } else {
        const total = ex.quotes.reduce((a, q) => a + q.row.wei, 0n), router = ex.quotes[0].router;
        const usdc = await balanceOf(USDC, from);
        if (usdc < total) throw new Error(`This wallet holds ${(Number(usdc) / 1e6).toFixed(2)} USDC; the basket needs ${(Number(total) / 1e6).toFixed(2)}.`);
        calls = [];
        if ((await allowanceOf(USDC, from, router)) < total) calls.push({ to: USDC, what: 'approval',
          data: '0x095ea7b3' + hex32(BigInt(router)) + hex32(total) + BUILDER_SUFFIX,
          landed: async () => (await allowanceOf(USDC, from, router)) >= total });
        calls.push(...ex.quotes.map(swap));
      }
      await sendCalls(p, from, calls);
    } catch (e) {
      ex.error = e && e.message ? e.message : 'The wallet rejected the transaction.';
      ex.state = 'ready';
    }
    ex.busy = false; draw();
  }

  window.NightBasket = { render };
})();
