// Base prices straight from KyberSwap, at the moment a snapshot is taken.
// Stock Check's feed is refreshed by a scheduled job that GitHub runs late or
// skips (2.11.2026: the Monday snapshot got prices seven hours old), so a record
// that is compared with the real open cannot lean on it. GitHub's runners reach
// KyberSwap fine; Cloudflare's addresses are the ones it limits.
const KYBER = 'https://aggregator-api.kyberswap.com/base/api/v1/routes';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const CORE = 'https://deftools.xyz/thesis-core.js'; // Coinbase's addresses, checked against base.org daily
const UA = { 'user-agent': 'Mozilla/5.0 (night.deftools.xyz data job)', 'x-client-id': 'night-shift' };
const DECIMALS = 8; // every Coinbase stock token on Base, checked onchain
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function stockAddresses() {
  const r = await fetch(CORE, { headers: UA });
  if (!r.ok) throw new Error(`thesis-core ${r.status}`);
  const m = { exports: {} };
  new Function('module', await r.text())(m);
  return Object.fromEntries(m.exports.TOKENS.map((t) => [t.s, t.a]));
}

// What $50 of USDC buys, as a price per share — the same number Stock Check shows.
export async function basePrice(address) {
  for (let i = 0; i < 3; i++) {
    await sleep(i ? 2000 : 400); // one at a time: parallel calls trip KyberSwap's limit
    try {
      const r = await fetch(`${KYBER}?tokenIn=${USDC}&tokenOut=${address}&amountIn=50000000`, { headers: UA });
      if (!r.ok) continue;
      const j = await r.json();
      const out = Number(j?.data?.routeSummary?.amountOut);
      if (j.code === 0 && out > 0) return 50 / (out / 10 ** DECIMALS);
    } catch (e) { /* try again */ }
  }
  return null;
}
