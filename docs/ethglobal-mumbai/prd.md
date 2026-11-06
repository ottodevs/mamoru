# PRD summary · ETHGlobal Mumbai 2026

Decided by Brais and Otto on 6 Nov 2026. Order of work: cap, harvest, stats.

## Goals

1. **Cap 10,000 USDC per account**, safe and provable: fork e2e with 10k and 100k deposits; what fits enters by pool depth, the rest waits, full withdrawal returns everything. The app reads the cap from settings. 1,000,000 after the 100k test passes.
2. **Full harvest**: collect Uniswap fees, sell them to USDC in a separate step sized on the real balance, reinvest with the usual bucket rules. Vault yield (share price growth) counts as earned. USDC above the threshold on one chain may return over CCTP to where it earns more.
3. **Public Stats at `app.mamoru.lol/stats`**, no account needed: total deposits (vaults included), volume placed by the engine, earned in 24 h and in total. Aggregates only; no breakdown with fewer than 3 accounts. Missing data shows as "not counted", never 0. Design phase with mockups before building.

## Constraints

- Engine spending limit per account (signed cap C): at most C moved in 24 h, 3C in 30 days, vault at most C/2. The engine checks the remaining budget before chaining sell and deposit; positions first, reinvestment second.
- No contract changes. Everything ships to beta, then to production together before submission.
- Out of scope: partner API, extra incentives (Merkl), APR change in Portfolio, the landing site.

## Success

Cap 10,000 written and read back in production; e2e evidence in the repo; real harvests with linked transactions; `/stats` live and the pitch numbers equal to it; small, frequent commits during the event.
