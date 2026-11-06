# Stats and Portfolio mockups (spec 013 amendment A1, v3 after Ot's and Brais's review)

Stats figures are real, read from Base and Monad on 6 Nov 2026 19:02Z by `apps/mamoru-operator/scripts/stats-figures.ts` (PR #326; method in `../results/stats-figures-2026-11-06.md`). Aggregates only; any group of fewer than 3 accounts is merged into a larger one. Portfolio uses example figures, labelled.

**Stats**, top to bottom: total deposits with money working as a share and one bar by place (stable vaults, liquidity pools, idle); earned in the last 24h, total earned, 7-day APR; total deposits (area, axes) and earned per day; APR by day with its 7-day average, for All, Base or Monad; accounts (total, average, largest); by asset and by chain as donuts (`#bars` shows the bar version for comparison).

**Portfolio**: Add capital / Withdraw on top; Total value as the main number; schematic value chart beside it (below on mobile): no grid or axes, smooth line, soft gradient, end marker, draw-in, value and date on hover or tap; Total earned as a signed pill (green up, red down, `#neg`).

Captures:
- `stats-1280.png`, `stats-390.png`, `stats-bars-1280.png`, `stats-monad-tip-1280.png`
- `portfolio-1280.png`, `portfolio-390.png`, `portfolio-hover-1280.png`, `portfolio-neg-390.png`

Render: `python3 -m http.server 8737` from the repo root, then e.g. `./shoot.sh stats.html 1280 1790 stats-1280.png`.
