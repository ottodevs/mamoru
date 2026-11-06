# Stats research (D1)

What established products do, and what we take. Fables is a content reference only.

| Pattern | Seen in | Take / reject |
|---|---|---|
| Two-item app nav: top text tabs at desktop, bottom tab bar on phones | iOS HIG tab bars, Revolut, Robinhood, Material navigation bar | **Take.** Bottom bar keeps Stats one thumb-tap away from the sign-up cards; no hamburger for two items. |
| TVL as one line, y from 0, range presets above the chart | DefiLlama, Uniswap Info, Morpho, Aave | **Take**, one series, no legend box. **Reject** log scales and dual axes. |
| One range control scopes every chart under it | Stripe dashboard, Uniswap Info | **Take**: 1W 1M 3M ALL over both TVL and volume, so the numbers agree. |
| Volume as daily bars on the same time axis | Uniswap Info, DefiLlama | **Take**, separate chart below (never a second y-axis). |
| Crosshair + one tooltip with date and value; tap-to-hold on touch | Robinhood, Stripe, Revolut | **Take**: value first, UTC date second, "so far" for today, keyboard arrows. |
| Compact money on axes (`$1K`), exact on headlines | Stripe, DefiLlama | **Take**: `$3,874` headline, `$4K` ticks, cents only under $100. |
| Partial / missing data shown as gaps with an explanation | Stripe ("incomplete period" dashed), Plausible | **Take**: hollow marker for today, hatched gap + "Not counted", never interpolated, never 0. |
| Source + freshness line under the figures | Dune, DefiLlama "updated" stamps | **Take**: one line, "data as of … UTC", stale past 1 h. |
| Per-address leaderboards | Uniswap Info, Dune | **Reject** for now: aggregates only, ≥ 3 accounts per figure (PRD). |
