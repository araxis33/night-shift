// Shared helpers: the stock list and Base prices from Stock Check, and Yahoo's chart API.
export const STOCK_DATA = 'https://deftools-check.araxis67.workers.dev/stock-data';
const UA = { 'user-agent': 'Mozilla/5.0 (night.deftools.xyz data job)' };

export async function baseStocks() {
  const r = await fetch(STOCK_DATA, { headers: UA });
  if (!r.ok) throw new Error(`stock-data ${r.status}`);
  const { items } = await r.json();
  return Object.entries(items).map(([symbol, v]) => ({
    symbol,
    ticker: symbol.replace(/c$/, ''),
    base: v.dex ?? null,
    baseAt: v.dexTs ?? null,
    loss: v.rt?.loss ?? null,
  }));
}

export async function chart(ticker, query) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?${query}`;
  for (let i = 0; i < 3; i++) {
    const r = await fetch(url, { headers: UA });
    if (r.ok) {
      const j = await r.json();
      const res = j.chart?.result?.[0];
      if (res) return res;
      return null;
    }
    if (r.status === 404) return null;
    await new Promise((s) => setTimeout(s, 1500 * (i + 1)));
  }
  return null;
}

export const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
