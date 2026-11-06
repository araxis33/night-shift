/* Night Shift — buy or sell a stock on Base, from its row.
   The same flow deftools.xyz has run on live money since September, cut down
   to what this page needs: Base only, pay or get back in ETH or USDC, quoted by
   KyberSwap, signed in the user's own wallet. Nothing here holds funds or asks
   for a key. Token addresses come from deftools' ThesisCore list (Coinbase's
   own contracts, checked against base.org every day). */
(function () {
  "use strict";

  const KYBER = "https://aggregator-api.kyberswap.com/base/api/v1";
  const BASE_RPC = "https://mainnet.base.org";
  const CHAIN_HEX = "0x2105"; // Base, 8453
  const SCAN = "https://basescan.org";
  const NATIVE_ETH = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
  const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const BUILDER_SUFFIX = "62635f6d726b7775326d300b0080218021802180218021802180218021";
  const SLIPPAGE_BPS = 100; // 1%
  const FEE_WALLET = "0x2ab08a231389fD6c1cb368769aE5Ba3f999209e4";
  const FEE_BPS = 10; // 0.1%, as on deftools
  const PAY = {
    ETH: { addr: NATIVE_ETH, sym: "ETH", dec: 18, native: true, presets: ["0.005", "0.01", "0.025", "0.05"], def: "0.01" },
    USDC: { addr: USDC, sym: "USDC", dec: 6, native: false, presets: ["5", "10", "25", "50"], def: "10" },
  };
  const SELL_PRESETS = [["25%", 25], ["50%", 50], ["75%", 75], ["Max", 100]];
  const AMOUNT_RE = /^[0-9]*[.]?[0-9]*$/;
  const REJECTED_RE = /user rejected|denied/i;
  const SEL_DECIMALS = "0x313ce567", SEL_BALANCEOF = "0x70a08231", SEL_ALLOWANCE = "0xdd62ed3e", SEL_APPROVE = "0x095ea7b3";

  const trade = { mode: "buy", pay: "ETH", token: null, symbol: "", account: null, summary: null, busy: false, seq: 0, decimals: {}, balance: null, done: null };

  const el = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const shortAddr = (a) => a.slice(0, 6) + "…" + a.slice(-4);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const addrArg = (a) => a.toLowerCase().replace("0x", "").padStart(64, "0");
  const uintArg = (v) => v.toString(16).padStart(64, "0");
  function fmtUsd(n) {
    if (!Number.isFinite(n)) return "—";
    return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  const payAsset = () => PAY[trade.pay] || PAY.ETH;
  // A sale always spends the stock; a purchase spends an ERC-20 only when paid in USDC.
  const spendsToken = () => trade.mode === "sell" || !payAsset().native;
  const spendToken = () => (trade.mode === "sell" ? trade.token : payAsset().addr);
  const spendSymbol = () => (trade.mode === "sell" ? trade.symbol : payAsset().sym);
  const spendsBalance = spendsToken;

  function ethProvider() {
    const p = window.ethereum;
    if (!p) return null;
    if (p.providers && p.providers.length) return p.providers.find((x) => x.isCoinbaseWallet) || p.providers[0];
    return p;
  }

  function toUnits(str, dec) {
    const clean = String(str).trim().replace(",", ".");
    if (clean === "" || clean === "." || !AMOUNT_RE.test(clean)) return null;
    const [whole = "0", frac = ""] = clean.split(".");
    const v = BigInt((whole || "0") + (frac + "0".repeat(dec)).slice(0, dec));
    return v > 0n ? v : null;
  }
  function fromUnits(v, dec) {
    const s = v.toString().padStart(dec + 1, "0");
    const n = Number(s.slice(0, -dec) + "." + s.slice(-dec));
    if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
    if (n >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
    return n.toLocaleString("en-US", { maximumFractionDigits: 8 });
  }
  // "Max" has to write a number that parses back exactly, so no grouping or rounding.
  function unitsToInput(v, dec) {
    const s = v.toString().padStart(dec + 1, "0");
    const frac = s.slice(-dec).replace(/0+$/, "");
    return frac ? s.slice(0, -dec) + "." + frac : s.slice(0, -dec);
  }

  // Reads go to a public Base node, never to the wallet: wallets are for signing,
  // and in-app browsers often never answer a read at all.
  async function rpc(method, params) {
    const res = await fetch(BASE_RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (!res.ok) throw new Error(res.status === 429 ? "The public Base node is busy. Try again in a moment." : "The Base node answered " + res.status + ".");
    const j = await res.json();
    if (j && j.error) throw new Error(j.error.message || "The node refused that read.");
    return j ? j.result : null;
  }
  async function ethCall(to, data) {
    const r = await rpc("eth_call", [{ to, data }, "latest"]);
    return r && r !== "0x" ? r : null;
  }
  async function decimalsOf(token) {
    if (trade.decimals[token] !== undefined) return trade.decimals[token];
    try {
      const r = await ethCall(token, SEL_DECIMALS);
      return (trade.decimals[token] = r ? parseInt(r, 16) : 18);
    } catch (e) { return 18; }
  }
  async function assetBalance(token, owner) {
    if (token.toLowerCase() === NATIVE_ETH.toLowerCase()) {
      const r = await rpc("eth_getBalance", [owner, "latest"]);
      return r ? BigInt(r) : 0n;
    }
    const r = await ethCall(token, SEL_BALANCEOF + addrArg(owner));
    return r ? BigInt(r) : 0n;
  }
  async function allowanceOf(token, owner, spender) {
    const r = await ethCall(token, SEL_ALLOWANCE + addrArg(owner) + addrArg(spender));
    return r ? BigInt(r) : 0n;
  }

  function status(html, bad, good) {
    const s = el("tr-status");
    s.className = "tr-status" + (bad ? " bad" : "") + (good ? " good" : "");
    s.innerHTML = html;
  }

  const ev = (n) => { try { navigator.sendBeacon("https://deftools-check.araxis67.workers.dev/ev", n); } catch (e) { /* a counter never gets in the way */ } };
  function open(token, symbol, mode) {
    ev("night_trade");
    trade.token = token; trade.symbol = symbol;
    el("tr-fee").textContent = "Fee " + (FEE_BPS / 100).toFixed(1) + "% to this site, already counted in the number above.";
    el("tr-addr").innerHTML = 'Coinbase contract <a href="' + SCAN + "/token/" + esc(token) + '" target="_blank" rel="noopener">' + esc(shortAddr(token)) + "</a>";
    el("tr-back").hidden = false;
    document.body.style.overflow = "hidden";
    setMode(mode || "buy");
    adoptExistingAccount();
  }

  // A wallet that has been here before still holds the permission; eth_accounts
  // reads it without opening anything.
  async function adoptExistingAccount() {
    const p = ethProvider();
    if (!p || trade.account) return null;
    try {
      const accounts = await p.request({ method: "eth_accounts" });
      if (!accounts || !accounts.length) return null;
      trade.account = accounts[0];
      status("Connected " + shortAddr(trade.account));
      renderCta();
      if (spendsBalance()) refreshBalance();
      return trade.account;
    } catch (e) { return null; }
  }

  function setMode(mode) {
    const sell = mode === "sell";
    const pa = payAsset();
    trade.mode = mode;
    trade.summary = null; trade.done = null; trade.balance = null;
    trade.seq++;
    el("tr-tx").hidden = true;
    status(trade.account ? "Connected " + shortAddr(trade.account) : "");
    document.querySelectorAll(".tr-tab").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
    document.querySelectorAll(".tr-pay-opt").forEach((b) => b.classList.toggle("on", b.dataset.pay === trade.pay));
    el("tr-pay").classList.toggle("sell", sell);
    el("tr-pay-label").textContent = sell ? "Get back" : "Pay with";
    el("tr-title").textContent = (sell ? "Sell " : "Buy ") + trade.symbol;
    el("tr-sub").textContent = "on Base, " + (sell ? "for " : "with ") + pa.sym;
    el("tr-unit").textContent = sell ? trade.symbol : pa.sym;
    el("tr-amount").setAttribute("aria-label", sell ? "Amount of " + trade.symbol + " to sell" : "Amount of " + pa.sym + " to spend");
    el("tr-amount").value = sell ? "" : pa.def;
    el("tr-presets").classList.toggle("sell", sell);
    el("tr-presets").innerHTML = sell
      ? SELL_PRESETS.map((p) => '<button class="tr-preset" type="button" data-pct="' + p[1] + '">' + p[0] + "</button>").join("")
      : pa.presets.map((v) => '<button class="tr-preset' + (v === pa.def ? " on" : "") + '" type="button" data-preset="' + v + '">' + v + " " + pa.sym + "</button>").join("");
    el("tr-bal").hidden = !spendsBalance();
    el("tr-bal").textContent = "";
    el("tr-quote").textContent = sell ? "Enter an amount, or take a share of what you hold." : "Enter an amount.";
    el("tr-note").textContent = (spendsToken()
      ? "This takes two signatures: an allowance for exactly the " + spendSymbol() + " being spent, then the swap. "
      : "") + "Quoted across every pool on Base by KyberSwap and signed in your own wallet. This page never holds your funds and never asks for a key.";
    renderCta();
    if (spendsBalance()) refreshBalance();
    if (!sell) quote();
  }

  async function refreshBalance() {
    if (!spendsBalance()) return;
    const b = el("tr-bal");
    if (!trade.account) { b.textContent = "Connect a wallet to see what you hold."; return; }
    const token = spendToken(), sym = spendSymbol();
    b.textContent = "Reading your balance…";
    try {
      const [bal, dec] = await Promise.all([assetBalance(token, trade.account), decimalsOf(token)]);
      if (spendToken() !== token) return; // the dialog moved on while this was in the air
      trade.balance = bal;
      b.innerHTML = bal > 0n ? "You hold <b>" + fromUnits(bal, dec) + " " + esc(sym) + "</b>" : "You hold no " + esc(sym) + ".";
    } catch (e) { b.textContent = "Could not read your balance."; }
    renderCta();
  }

  function close() {
    el("tr-back").hidden = true;
    document.body.style.overflow = "";
    trade.seq++;
  }

  function renderCta() {
    const cta = el("tr-action");
    const sell = trade.mode === "sell";
    cta.classList.toggle("sell", sell);
    if (trade.busy) { cta.disabled = true; return; }
    cta.disabled = false;
    if (trade.done) { cta.textContent = "Done"; return; }
    if (!trade.account) { cta.textContent = "Connect wallet"; return; }
    cta.textContent = trade.summary ? (sell ? "Sell " : "Buy ") + trade.symbol : "Enter an amount";
    cta.disabled = !trade.summary;
  }

  async function quote() {
    const seq = ++trade.seq;
    const sell = trade.mode === "sell";
    const out = el("tr-quote");
    const pa = payAsset();
    trade.summary = null;
    const tokenDec = await decimalsOf(trade.token);
    if (seq !== trade.seq) return;
    const inDec = sell ? tokenDec : pa.dec, outDec = sell ? pa.dec : tokenDec;
    const amountIn = toUnits(el("tr-amount").value, inDec);
    if (!amountIn) { out.textContent = sell ? "Enter an amount, or take a share of what you hold." : "Enter an amount."; renderCta(); return; }
    if (trade.balance !== null && amountIn > trade.balance) { out.textContent = "That is more " + spendSymbol() + " than you hold."; renderCta(); return; }
    out.textContent = "Finding the best route…";
    renderCta();
    try {
      // The fee rides in the quote, so the number shown is what arrives. With an
      // ERC-20 going in it comes out of what comes back, so the allowance never
      // covers more than the amount typed; an ETH purchase pays it on the way in.
      const url = KYBER + "/routes?tokenIn=" + (sell ? trade.token : pa.addr) + "&tokenOut=" + (sell ? pa.addr : trade.token) +
        "&amountIn=" + amountIn + "&gasInclude=true" +
        "&feeAmount=" + FEE_BPS + "&chargeFeeBy=" + (spendsToken() ? "currency_out" : "currency_in") + "&isInBps=true&feeReceiver=" + FEE_WALLET;
      const j = await (await fetch(url)).json();
      if (seq !== trade.seq) return;
      if (!j || j.code !== 0 || !j.data) throw new Error("No route for this amount.");
      const sum = j.data.routeSummary;
      trade.summary = sum;
      const got = fromUnits(BigInt(sum.amountOut), outDec) + " " + (sell ? pa.sym : trade.symbol);
      const inUsd = parseFloat(sum.amountInUsd), outUsd = parseFloat(sum.amountOutUsd);
      let tail = "";
      if (inUsd > 0 && outUsd > 0) {
        const cost = (inUsd - outUsd) / inUsd * 100;
        if (cost > 0) tail = " · " + cost.toFixed(2) + "% to fees and price impact";
      }
      out.innerHTML = "≈ " + esc(got) + '<span class="dim">' + fmtUsd(inUsd) + " in → " + fmtUsd(outUsd) + " out" + tail + "</span>";
    } catch (e) {
      if (seq !== trade.seq) return;
      trade.summary = null;
      out.textContent = e.message || "Could not price this swap.";
    }
    renderCta();
  }

  async function ensureBase(p) {
    const chain = await p.request({ method: "eth_chainId" });
    if (chain === CHAIN_HEX) return;
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_HEX }] });
  }

  async function connectWallet() {
    const p = ethProvider();
    if (!p) throw new Error("No wallet in this browser. Open the page inside Coinbase Wallet, or install one.");
    const accounts = await p.request({ method: "eth_requestAccounts" });
    trade.account = accounts[0];
    await ensureBase(p);
    status("Connected " + shortAddr(trade.account));
  }

  async function waitForReceipt(p, hash, what) {
    for (let i = 0; i < 90; i++) {
      let r = null;
      try { r = await rpc("eth_getTransactionReceipt", [hash]); } catch (e) { r = null; }
      if (!r && p && p.request) { try { r = await p.request({ method: "eth_getTransactionReceipt", params: [hash] }); } catch (e) { r = null; } }
      if (r && r.blockNumber) {
        if (r.status === "0x0") throw new Error("The " + (what || "swap") + " reverted onchain. Nothing left your wallet but gas.");
        return r;
      }
      await sleep(2000);
    }
    throw new Error("Timed out waiting for the confirmation.");
  }

  // Wallets in in-app browsers sometimes lose the reply to eth_sendTransaction,
  // so the chain is watched in parallel and whichever answers first wins.
  async function signAndConfirm(p, tx, what, landed) {
    const abort = { stop: false };
    const sent = p.request({ method: "eth_sendTransaction", params: [tx] });
    sent.catch(() => {});
    const watch = async (seconds) => {
      const until = Date.now() + seconds * 1000;
      while (Date.now() < until) {
        await sleep(3000);
        if (abort.stop) return false;
        try { if (await landed()) return true; } catch (e) { /* keep watching */ }
      }
      return false;
    };
    let answer = null;
    try { answer = await Promise.race([sent, watch(240)]); }
    catch (err) {
      if (REJECTED_RE.test((err && err.message) || "")) throw err;
      answer = await watch(45);
    }
    abort.stop = true;
    if (typeof answer === "string" && answer) { await waitForReceipt(p, answer, what); return answer; }
    if (answer === true) return null;
    throw new Error("The wallet never came back on the " + what + ". Nothing is stuck on this page — check the wallet, then try again.");
  }

  async function requoteAfterApproval() {
    for (let i = 0; i < 3; i++) {
      await quote();
      if (trade.summary) return true;
      await sleep(1500);
    }
    return false;
  }

  // Exactly the amount being spent: an unlimited approval outlives the trade.
  async function approveExactly(p, token, spender, amount) {
    const current = await allowanceOf(token, trade.account, spender);
    if (current >= amount) return;
    const approval = (value) => ({ from: trade.account, to: token, value: "0x0", data: SEL_APPROVE + addrArg(spender) + uintArg(value) + BUILDER_SUFFIX });
    if (current > 0n) {
      status("Clearing the old allowance — confirm it in your wallet.");
      await signAndConfirm(p, approval(0n), "approval", async () => (await allowanceOf(token, trade.account, spender)) === 0n);
    }
    status("Approve " + esc(spendSymbol()) + " in your wallet. This lets the router take exactly what this trade spends, and nothing more.");
    await signAndConfirm(p, approval(amount), "approval", async () => (await allowanceOf(token, trade.account, spender)) >= amount);
  }

  async function buildSwap() {
    const res = await fetch(KYBER + "/route/build", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ routeSummary: trade.summary, sender: trade.account, recipient: trade.account, slippageTolerance: SLIPPAGE_BPS, source: "night.deftools.xyz" }),
    });
    const b = await res.json();
    if (!b || b.code !== 0 || !b.data) throw new Error("Could not build this swap. Try a different amount.");
    return b.data;
  }

  async function doTrade() {
    if (trade.busy) return;
    if (trade.done) { close(); return; }
    if (!trade.account) {
      trade.busy = true; renderCta();
      try { await connectWallet(); } catch (e) { status(esc(e.message || "The wallet refused the connection."), true); }
      trade.busy = false; renderCta();
      if (trade.account) { if (spendsBalance()) await refreshBalance(); quote(); }
      return;
    }
    if (!trade.summary) return;
    const sell = trade.mode === "sell";
    const pa = payAsset();
    const spends = spendsToken();
    trade.busy = true; renderCta();
    status("Building the swap…");
    try {
      const p = ethProvider();
      await ensureBase(p);
      let built = await buildSwap();
      if (spends) {
        const token = spendToken();
        const need = BigInt(trade.summary.amountIn);
        if ((await allowanceOf(token, trade.account, built.routerAddress)) < need) {
          await approveExactly(p, token, built.routerAddress, need);
          status("Approved. Pricing it again…");
          if (!(await requoteAfterApproval())) throw new Error("The allowance is granted, but a fresh price would not load. Press the button again — you will not be asked to approve twice.");
          built = await buildSwap();
        }
      }
      status("Confirm it in your wallet.");
      const token = trade.token;
      const before = await assetBalance(token, trade.account);
      const hash = await signAndConfirm(p, {
        from: trade.account,
        to: built.routerAddress,
        value: spends ? "0x0" : "0x" + BigInt(trade.summary.amountIn).toString(16),
        data: built.data + BUILDER_SUFFIX,
      }, "swap", async () => (await assetBalance(token, trade.account)) !== before);
      const tx = el("tr-tx");
      tx.href = hash ? SCAN + "/tx/" + hash : SCAN + "/address/" + trade.account;
      tx.textContent = hash ? "View the transaction" : "See it on the explorer";
      tx.hidden = false;
      trade.done = hash || "onchain";
      ev("night_tx");
      status(sell ? "Sold. The " + pa.sym + " is in your wallet." : esc(trade.symbol) + " is in your wallet.", false, true);
      if (spendsBalance()) refreshBalance();
    } catch (e) {
      const m = (e && (e.message || String(e))) || "";
      status(REJECTED_RE.test(m) ? "Cancelled in the wallet." : esc(m || "The swap failed."), true);
    }
    trade.busy = false; renderCta();
  }

  // ---- wiring ----
  el("tr-close").addEventListener("click", close);
  el("tr-back").addEventListener("click", (e) => { if (e.target.id === "tr-back") close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !el("tr-back").hidden) close(); });
  el("tr-action").addEventListener("click", doTrade);
  el("tr-tabs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-mode]");
    if (!b || trade.busy || b.dataset.mode === trade.mode) return;
    setMode(b.dataset.mode);
  });
  el("tr-pay").addEventListener("click", (e) => {
    const b = e.target.closest("[data-pay]");
    if (!b || trade.busy || b.dataset.pay === trade.pay) return;
    trade.pay = b.dataset.pay;
    setMode(trade.mode);
  });
  el("tr-presets").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-preset],[data-pct]");
    if (!b) return;
    document.querySelectorAll(".tr-preset").forEach((x) => x.classList.toggle("on", x === b));
    if (b.dataset.preset !== undefined) { el("tr-amount").value = b.dataset.preset; quote(); return; }
    if (!trade.account) await adoptExistingAccount();
    if (!trade.account) { try { await connectWallet(); } catch (err) { status(esc(err.message || "The wallet refused the connection."), true); } }
    if (!trade.account) { b.classList.remove("on"); return; }
    if (trade.balance === null) await refreshBalance();
    if (!trade.balance) { b.classList.remove("on"); return; }
    const dec = await decimalsOf(trade.token);
    el("tr-amount").value = unitsToInput(trade.balance * BigInt(b.dataset.pct) / 100n, dec);
    quote();
  });
  let quoteTimer = null;
  el("tr-amount").addEventListener("input", () => {
    document.querySelectorAll(".tr-preset").forEach((x) => x.classList.remove("on"));
    if (trade.done) { trade.done = null; el("tr-tx").hidden = true; status(""); }
    clearTimeout(quoteTimer);
    quoteTimer = setTimeout(quote, 400);
  });
  (function watchWallet() {
    const p = ethProvider();
    if (!p || !p.on) return;
    p.on("accountsChanged", (accounts) => {
      trade.account = (accounts && accounts[0]) || null;
      trade.balance = null;
      status(trade.account ? "Connected " + shortAddr(trade.account) : "Wallet disconnected.");
      if (!el("tr-back").hidden) { if (spendsBalance()) refreshBalance(); quote(); }
      renderCta();
    });
  })();

  window.NightTrade = { open };
})();
