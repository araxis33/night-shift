# Night Shift

Is it a good price right now? US stocks on Base while Wall Street sleeps.

**Live:** https://night.deftools.xyz

- **Base now** — KyberSwap quote for each Coinbase stock token on Base (via [Stock Check](https://deftools.xyz/stocks.html), refreshed every 30 minutes).
- **Last close / after-hours** — Yahoo Finance, collected by GitHub Actions after each US session (`scripts/closes.mjs`).
- **Gap** — Base price vs the last real trade. 2% or more: pricey. -2% or less: cheap.
- **$1,000 round trip** — what you keep if you buy $1,000 and sell it back right away. Stocks that lose 5% or more have no real market on Base and are left out.
- **Monday check** — every Monday, the Base price an hour before the open next to how each stock really opened (`scripts/monday.mjs`, one file per week in `data/checks/`).

Built for Vibeathon 02: Night Shift. Part of [deftools](https://deftools.xyz). Not financial advice.
