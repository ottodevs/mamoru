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
| 1 | Cap 1,000 → 10,000 USDC per account | [`specs/011-mumbai-cap`](specs/011-mumbai-cap/) | **Live.** Settings raised to 10,000 in production on 7 Nov 01:51 IST; existing accounts take it with one renewal, new accounts get it at creation. Base fork e2e: 10k, 30k and 60k placed by pool depth, Stop returns ≥ 99.93 % ([results](specs/011-mumbai-cap/results/README.md)). V3 bridge sends kept inside their signed limit; spends paused after a spending-limit refusal. A 100k activation reverted on the fork; a call trace in PR #328 traced it to a pool's signed daily budget above what the pool can absorb (the first note in the results guessed gas packing). The fix is in review, so 1,000,000 waits for it. |
| 2 | Full harvest: fees sold to USDC and reinvested; vault yield counted as earned | [`specs/012-mumbai-harvest`](specs/012-mumbai-harvest/) | **Live.** Running in both operators (Base and Monad) since 7 Nov ~05:00 IST. First full cycle on Monad mainnet: [collect](https://monadscan.com/tx/0xd758f36474508fb183a66426f139b406687893262eadaa9671c36d1f920b880a), then [sale of the harvested WMON to USDC](https://monadscan.com/tx/0xb70997961c2f32e916dc8f84f5bbfdbae1cb5062a54a6d265ca980d70d675e29) in its own step. Included: the sale of harvested volatile in its own step (never principal), sweep of idle USDC into the stable vault, income ledger per event with vault yield on engine-explained shares. Monad sleeves on V3 have no bridge-out grant, so their idle USDC cannot return to Base yet: that needs a new grant signed by the owner and the V3 return path, after the hackathon ([check](specs/012-mumbai-harvest/results/v3-monad-return-2026-11-06.md)). |
| 3 | Public [Stats](https://app.mamoru.lol/stats) and a Portfolio + Stats menu | [`specs/013-mumbai-stats`](specs/013-mumbai-stats/) ([amendment A1](specs/013-mumbai-stats/amendment-a1.md)) | **Live** at [app.mamoru.lol/stats](https://app.mamoru.lol/stats) since 7 Nov ~05:55 IST. Deposits, money working, earned (24 h, total), 7-day APR, exposure by asset and chain, APR over time, accounts, on Base and Monad. Aggregates only: no figure backed by fewer than 3 accounts. Total deposits and the splits matched a direct chain read within $1 on a copy of the database ([check](specs/013-mumbai-stats/results/stats-backfill-check-2026-11-06.md)). Earned adds what the ledger can count (fees collected and accrued, valued in USD, and vault yield on engine-explained shares); a few old receipts without a price and vault shares the ledger cannot attribute are left out, so it is a floor. Accounts are counted per owner, not per Safe. |

## In production

- **App** `44b971b0` on [app.mamoru.lol](https://app.mamoru.lol) (7 Nov ~05:55 IST); **operators** `5e06f9c0` on Base and Monad (7 Nov ~05:00 IST).
- **Cap** 10,000 USDC per account in the production settings since 7 Nov 01:51 IST.
- **Harvest** [collect](https://monadscan.com/tx/0xd758f36474508fb183a66426f139b406687893262eadaa9671c36d1f920b880a) → [sale to USDC](https://monadscan.com/tx/0xb70997961c2f32e916dc8f84f5bbfdbae1cb5062a54a6d265ca980d70d675e29) (Monad mainnet, 7 Nov).
- **Stats** read 7 Nov 05:49 IST: deposits $4,365 · 91 % working · earned 24 h $1.04 · total earned $3.03 · 7-day APR 28.1 % · 59 accounts.
- **Not shipped:** the 100k activation fix (PR #328, reviewed, waiting on a fork run), the "not counted" marker under Total earned (PR #309, waiting on copy approval).

## Planning artifacts

- PRD (summary): [`docs/ethglobal-mumbai/prd.md`](docs/ethglobal-mumbai/prd.md)
- Specs: `specs/011` to `specs/013` (spec, plan, tasks, scenarios)
- How we worked and where AI was used: [`docs/process/ai-attribution.md`](docs/process/ai-attribution.md)
