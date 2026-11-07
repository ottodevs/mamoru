# ETHGlobal Mumbai 2026 · Continuity

Mamoru is a non-custodial savings app: USDC in a Safe owned by your passkey, put to work by an engine that can only act inside on-chain rules you signed. It started at ETHGlobal Tokyo (25–27 Sep 2026) and has been live with real funds since.

## Cut line

| | Commit | Time |
|---|---|---|
| Last commit before hacking | tag [`ethglobal-mumbai-start`](https://github.com/ottodevs/mamoru/releases/tag/ethglobal-mumbai-start) (`c8674dd2`) | 5 Nov 2026, before 21:00 IST |
| Submission | tag `ethglobal-mumbai-submission` | _set at submission_ |

Everything in [`ethglobal-mumbai-start...ethglobal-mumbai-submission`](https://github.com/ottodevs/mamoru/compare/ethglobal-mumbai-start...main) was written during the event. Pull requests from the event carry the label [`ethglobal-mumbai`](https://github.com/ottodevs/mamoru/pulls?q=label%3Aethglobal-mumbai). No history before the cut was rewritten.

## Before Mumbai

Passkey-owned Safe accounts on Base and Monad, ERC-7579 session with an on-chain action policy (V4), engine with buckets, re-range and fee collection, CCTP between chains, Strategy Lab, fork scenario catalog. Per-account cap: 1,000 USDC. Harvest collected fees but left them unsold. No public numbers.

## During Mumbai

| # | Piece | Spec | Status |
|---|---|---|---|
| 1 | Cap 1,000 → 10,000 USDC per account | [`specs/011-mumbai-cap`](specs/011-mumbai-cap/) | **Live.** Settings raised to 10,000 in production on 7 Nov 01:51 IST; existing accounts take it with one renewal, new accounts get it at creation. Base fork e2e: 10k, 30k and 60k placed by pool depth, Stop returns ≥ 99.93 % ([results](specs/011-mumbai-cap/results/README.md)). V3 bridge sends kept inside their signed limit; spends paused after a spending-limit refusal. A 100k activation reverted on the fork (a pool's signed daily budget above what the pool can absorb); the fix is in review, so 1,000,000 waits for it. |
| 2 | Full harvest: fees sold to USDC and reinvested; vault yield counted as earned | [`specs/012-mumbai-harvest`](specs/012-mumbai-harvest/) | **Merged and running** in both operators (Base and Monad) since 7 Nov 05:30 IST: the sale of harvested volatile in its own step (never principal), sweep of idle USDC into the stable vault, income ledger per event with vault yield on engine-explained shares. Monad sleeves on V3 have no bridge-out grant, so their USDC returns to Base after a renewal ([check](specs/012-mumbai-harvest/results/v3-monad-return-2026-11-06.md)). |
| 3 | Public [Stats](https://app.mamoru.lol/stats) and a Portfolio + Stats menu | [`specs/013-mumbai-stats`](specs/013-mumbai-stats/) ([amendment A1](specs/013-mumbai-stats/amendment-a1.md)) | **On beta**, production at the final cut. Deposits, money working, earned (24 h, total), 7-day APR, exposure by asset and chain, APR over time, accounts. Aggregates only: no figure backed by fewer than 3 accounts. Figures reconciled against a direct chain read ([check](specs/013-mumbai-stats/results/stats-backfill-check-2026-11-06.md)). |

## In production

_Filled at submission: release tag, transactions, Stats figures with their read time._

## Planning artifacts

- PRD (summary): [`docs/ethglobal-mumbai/prd.md`](docs/ethglobal-mumbai/prd.md)
- Specs: `specs/011` to `specs/013` (spec, plan, tasks, scenarios)
- How we worked and where AI was used: [`docs/process/ai-attribution.md`](docs/process/ai-attribution.md)
