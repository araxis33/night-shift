// Monday check, in two runs.
//   node scripts/monday.mjs night  — about an hour before the open: Base price of every
//                                    stock with a real market, next to Friday's last trade.
//   node scripts/monday.mjs open   — after the open: how each stock really opened.
// One file per Monday in data/checks/, listed in data/checks/index.json.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { baseStocks, chart, sleep } from './yahoo.mjs';
import { stockAddresses, basePrice } from './kyber.mjs';

const TRAP = 5; // % lost on a $1,000 round trip: above this the Base price means nothing
const mode = process.argv[2];
const date = new Date().toISOString().slice(0, 10);
const file = `data/checks/${date}.json`;
const indexFile = 'data/checks/index.json';

if (mode === 'night') {
  const closes = JSON.parse(readFileSync('data/closes.json', 'utf8')).items;
  const items = {};
  const addr = await stockAddresses();
  // Which stocks have a real market comes from Stock Check's round trips (they move slowly);
  // the price itself is asked of KyberSwap now, so the record never holds a stale one.
  for (const s of await baseStocks()) {
    const c = closes[s.ticker];
    if (!c || !addr[s.symbol] || s.loss == null || s.loss >= TRAP) continue;
    const base = await basePrice(addr[s.symbol]);
    if (base == null) { console.log(`${s.ticker}: no quote`); continue; }
    items[s.ticker] = { base, ref: c.ah ?? c.close };
  }
  writeFileSync(file, JSON.stringify({ date, nightAt: Math.floor(Date.now() / 1000), items }, null, 1) + '\n');
  const index = existsSync(indexFile) ? JSON.parse(readFileSync(indexFile, 'utf8')) : [];
  if (!index.includes(date)) index.unshift(date);
  writeFileSync(indexFile, JSON.stringify(index) + '\n');
  console.log(`night: ${Object.keys(items).length} stocks`);
} else if (mode === 'open') {
  const check = JSON.parse(readFileSync(file, 'utf8'));
  for (const [ticker, it] of Object.entries(check.items)) {
    const res = await chart(ticker, 'interval=1m&range=1d');
    await sleep(250);
    if (!res) continue;
    const start = res.meta.currentTradingPeriod?.regular?.start;
    const t = res.timestamp || [];
    const o = res.indicators?.quote?.[0]?.open || [];
    for (let i = 0; i < t.length; i++) {
      if (t[i] >= start && o[i] != null) { it.open = o[i]; break; }
    }
  }
  check.openAt = Math.floor(Date.now() / 1000);
  writeFileSync(file, JSON.stringify(check, null, 1) + '\n');
  console.log(`open: ${Object.values(check.items).filter((i) => i.open != null).length} stocks`);
} else {
  console.error('usage: monday.mjs night|open');
  process.exit(1);
}
