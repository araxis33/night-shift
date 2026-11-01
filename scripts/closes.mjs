// After each US session: the regular close and the last after-hours price for every
// Coinbase stock that trades on Base. Written to data/closes.json for the page.
import { writeFileSync } from 'node:fs';
import { baseStocks, chart, sleep } from './yahoo.mjs';

const stocks = await baseStocks();
const items = {};
for (const s of stocks) {
  const res = await chart(s.ticker, 'interval=5m&range=5d&includePrePost=true');
  await sleep(250);
  if (!res) { console.log(`${s.ticker}: no Yahoo data`); continue; }
  const m = res.meta;
  const close = m.regularMarketPrice;
  const closeAt = m.regularMarketTime;
  // Last after-hours trade: the latest 5-minute candle after the regular close.
  let ah = null, ahAt = null;
  const t = res.timestamp || [];
  const c = res.indicators?.quote?.[0]?.close || [];
  for (let i = t.length - 1; i >= 0; i--) {
    if (t[i] <= closeAt) break;
    if (c[i] != null) { ah = c[i]; ahAt = t[i]; break; }
  }
  items[s.ticker] = { close, closeAt, ah, ahAt };
}
const out = { at: Math.floor(Date.now() / 1000), items };
writeFileSync('data/closes.json', JSON.stringify(out, null, 1) + '\n');
console.log(`closes: ${Object.keys(items).length} of ${stocks.length} stocks`);
