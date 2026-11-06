# Stats mockups (spec 013 amendment A1)

Real figures, read from Base and Monad on 6 Nov 2026 19:02Z by `apps/mamoru-operator/scripts/stats-figures.ts` (PR #326; numbers and method in `../results/stats-figures-2026-11-06.md`). Aggregates only; any group of fewer than 3 accounts is merged into a larger one.

The page answers three questions, top to bottom:
1. **Where is the money?** Total deposits, split into money working and idle, and one bar by place: stable vaults, liquidity pools, idle.
2. **What does it earn, and does it hold?** Earned in the last 24h, total earned, 7-day APR; APR by day with its 7-day average, for All, Base or Monad.
3. **What does it hold?** Exposure by asset (pools split into their two tokens) and by chain; share in stablecoins; accounts (total, average, largest).

Captures: `stats-1280.png`, `stats-390.png`, `stats-monad-tip-1280.png` (Monad APR with the hover tooltip). Portfolio mockups are unchanged.

Copy for OK (English): every (i) text is in `stats.html`. Title "Stats", subtitle "Every Mamoru account, added up."

Render: `python3 -m http.server 8737` from the repo root, then `./shoot.sh stats.html 1280 1700 stats-1280.png`.
