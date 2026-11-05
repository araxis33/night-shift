// "Beat the night": opens next Monday's round right after Friday's after-hours end.
//   node scripts/game.mjs           — runs with the Friday closes job; does nothing on other days
//   node scripts/game.mjs --force   — open the round for the coming Monday now
// The five stocks: ones that are cheap to trade on Base (a $1,000 round trip loses under 2%),
// the five that moved most in Friday's after-hours. Written to data/game/<monday>.json and
// listed in data/game/index.json. Scores come later from the Monday check (data/checks/).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { baseStocks } from './yahoo.mjs';

const CHEAP = 2;   // % lost on a $1,000 round trip: only stocks you can really trade
const COUNT = 5;
const CORE = 'https://deftools.xyz/thesis-core.js';
const force = process.argv.includes('--force');

const nyOf = (d) => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
  .formatToParts(d).map((x) => [x.type, x.value]));

const now = new Date();
if (!force && nyOf(now).weekday !== 'Fri') { console.log('game: not Friday in New York, nothing to open'); process.exit(0); }

// Next Monday 9:25 New York (five minutes before the bell) = the lock.
let lock = null;
for (let t = Math.ceil(now.getTime() / 300000) * 300000; t < now.getTime() + 8 * 864e5; t += 300000) {
  const p = nyOf(new Date(t));
  if (p.weekday === 'Mon' && +p.hour % 24 === 9 && p.minute === '25') { lock = new Date(t); break; }
}
const ny = nyOf(lock);
const date = `${ny.year}-${ny.month}-${ny.day}`;
const file = `data/game/${date}.json`, indexFile = 'data/game/index.json';
if (existsSync(file)) { console.log(`game: ${date} already open`); process.exit(0); }

const closes = JSON.parse(readFileSync('data/closes.json', 'utf8')).items;
const r = await fetch(CORE);
const m = { exports: {} };
new Function('module', await r.text())(m);
const names = Object.fromEntries(m.exports.TOKENS.map((t) => [t.s.replace(/c$/, ''), t.co]));

const pool = (await baseStocks())
  .filter((s) => s.loss != null && s.loss < CHEAP && closes[s.ticker]?.close)
  .map((s) => { const c = closes[s.ticker]; return { ticker: s.ticker, name: names[s.ticker] || s.ticker, close: c.close, ah: c.ah ?? null, ref: c.ah ?? c.close, move: c.ah ? Math.abs(c.ah / c.close - 1) : 0 }; })
  .sort((a, b) => b.move - a.move);
if (pool.length < COUNT) { console.error(`game: only ${pool.length} tradable stocks, round not opened`); process.exit(1); }
const stocks = pool.slice(0, COUNT).map(({ move, ...s }) => s);

mkdirSync('data/game', { recursive: true });
writeFileSync(file, JSON.stringify({ date, lockAt: Math.floor(lock.getTime() / 1000), at: Math.floor(now.getTime() / 1000), stocks }, null, 1) + '\n');
const index = existsSync(indexFile) ? JSON.parse(readFileSync(indexFile, 'utf8')) : [];
if (!index.includes(date)) index.unshift(date);
writeFileSync(indexFile, JSON.stringify(index) + '\n');
console.log(`game: ${date} open, lock ${lock.toISOString()}: ${stocks.map((s) => s.ticker).join(', ')}`);
