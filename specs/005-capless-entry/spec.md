# 005: Entries sized to pool depth, instead of a fixed account cap

Ticket: otto/mamoru#127 (and the reason-code half of #128). Status: phase 1 built behind a flag, off by default.
Numbering: 003 (snapshot loop, PR #36) and 004 (loss control, PR #37) are taken on their branches.

## Problem

Every account is capped at 100 USDC (`LIVE_CAP_USDC`). The cap exists in two places, and both have to go for
Mamoru to take larger deposits:

1. **The Start gate.** The operator refuses to activate a Safe that holds more than the cap
   (`DEPOSIT_OVER_CAP`), and the app shows the cap.
2. **The session limits on chain.** The grants an owner signs are sized from the cap, not from the deposit
   (`computeCaps(policy, LIVE_CAP_USDC, prices)` in the operator). With the live policy that is, for one year of
   validity: stables pair swaps 50 USDC per call and 100 in total, mints 100; BTC pair 40 / 80 / 80; ETH pair
   20 / 40 / 40. A deposit larger than the cap could not be placed even if the gate let it through, because the
   session key cannot move more than these amounts. The limits are also cumulative: re-ranges and swaps spend them
   over the year.

A fixed cap is the wrong question. What can go into a pool depends on the pool at that block: how deep it is near the
price, and how much of it Mamoru already holds.

## Measured capacity on Base (16 Oct 2026, block ~52.66M)

`apps/mamoru-operator/scripts/pool-capacity.ts`, read only, public RPC. Swap capacity is the largest USDC sale into the
pool whose average execution price is within X bps of spot, after the pool fee, from QuoterV2 (it crosses ticks).
Share capacity is the value of a position of the policy width (40 ticks for stables, 2000 for the others) holding Y% of
the pool's active liquidity. All figures in USDC.

| Bucket | Pool | Live | TVL | Swap @10 bps | Swap @30 bps | Swap @50 bps | Share 1% | Share 5% | Share 10% |
|---|---|---|---|---|---|---|---|---|---|
| stables | USDC/USDT 0.01% | yes | 199,220 | 103,223 | 112,430 | 113,299 | 3,210 | 16,050 | 32,100 |
| stables | USDC/USDT 0.05% | | 16,269 | 10,861 | 10,883 | 10,905 | 267 | 1,334 | 2,668 |
| btc-usdc | USDC/cbBTC 0.05% | yes | 9,734,440 | 75,905 | 227,988 | 381,293 | 74,023 | 370,115 | 740,230 |
| btc-usdc | USDC/cbBTC 0.3% | | 2,846,416 | 17,882 | 53,346 | 88,621 | 17,372 | 86,859 | 173,718 |
| btc-usdc | USDC/cbBTC 0.01% | | 500 | 1 | 1 | 1 | 0 | 0 | 1 |
| risk | WETH/USDC 0.3% | yes | 146,231,281 | 1,573,622 | 4,717,639 | 7,842,504 | 1,528,722 | 7,643,610 | 15,287,220 |
| risk | WETH/USDC 0.05% | | 9,100,612 | 53,832 | 160,319 | 266,662 | 53,366 | 266,828 | 533,655 |
| risk | WETH/USDC 0.01% | | 494,341 | 4,134 | 13,132 | 22,236 | 4,022 | 20,110 | 40,220 |

What this says:

- **The stables bucket is the binding one.** At 5% of its active liquidity the live USDC/USDT pool takes about 16k
  USDC of position from Mamoru, and there is no second Uniswap v3 stables pool on Base worth overflowing into
  (the 0.05% tier has 16k of TVL). With the live weights (50% stables), an account starts to wait for depth in this
  bucket from about 32k USDC. Overflow for stables needs another venue (Uniswap v4, Aerodrome, or lending): phase 3.
- **BTC overflows well**: the 0.3% tier takes about a quarter of what the 0.05% does, an extra ~87k at 5%.
- **ETH is not a constraint** below several million USDC.
- The share limit must be read across **all** Mamoru accounts in a pool, not one account: Mamoru as a whole must not
  become the market. Phase 1 counts the account's own positions (decide is per account); phase 2 adds the operator's
  aggregate over all managed positions in the pool.

## Rule

At every entry, at the decision block, for the bucket's pool:

- `shareRoom`: value of the liquidity the account may still add so its in-range liquidity stays at or under
  `maxShareBps` of the pool's active liquidity.
- `swapRoom`: the largest savings sale whose average execution impact is at most `maxImpactBps` against the active
  liquidity (constant-liquidity, linearised: Δ1 = b·L·√P, Δ0 = b·L/√P, b the impact as a fraction). It does not see
  liquidity beyond the current tick range: conservative in a pool whose depth falls off slowly, optimistic in one with a
  cliff next to the price. Phase 2 checks the proposed swap with QuoterV2 before sending it.
- The next entry of the bucket is `min(gap, available, shareRoom, swapRoom / volatileShare)`. If that is under
  `minEntry`, nothing is proposed for the bucket. Its shortfall stays as USDC with reason `DECIDE_WAIT_DEPTH` and the
  amount, and the next bucket in the order gets the entry.
- What is placed is placed in several steps (a partial fill per review), each one re-checked against the pool at
  its own block.

Initial thresholds (phase 1): `maxImpactBps` 30 for the volatile pools, 5 for USDC/USDT 0.01% (its fee is 1 bp; 5 bps
of impact is five times what the pool charges); `maxShareBps` 500 (5%).

Why these numbers: at 30 bps the impact on an entry is paid back by fees in under two weeks at the yields measured in
September (1.2% per month at 1k on the live mix), and 5% of active liquidity keeps Mamoru far from being most of the
market near the price, so an exit can always be absorbed. Both are policy fields, recalibrated in the Lab.

## Waiting money, said in the app (#128)

Money held back on purpose must never look like Mamoru stopped. The decision's buckets carry `waiting` (raw
savings units) when they wait for depth (`DECIDE_WAIT_DEPTH`) or because their market is in a fast fall
(`DECIDE_ENTRY_PAUSED_FALL`, spec 004 freeze, PR #39). The operator keeps the last review's waiting buckets and
returns them in `FundingView.engine.waiting` with `reviewedAt`. The app shows one plain line:

- "40.00 USDC is waiting: the USDC/USDT pool cannot take more right now without moving its price. Checked at 10:05."
- "12.50 USDC is waiting: USDC/cbBTC is falling fast, so Mamoru adds nothing there until it settles. Checked at 10:05."

Other reasons money can wait already have their own lines (a missing approval: the extend row from #33; not
started: the Start row). Retry cadence is the normal review (5 min; 15 min when the RPC budget brake is on).

## Lab gate (16 Oct 2026)

`packages/backtest`, real history: September 2026 (30 days, 5 min), October 2025 and February 2025 crash weeks
(10 min). Live policy without the cap vs the same policy with depth sizing (30 / 500 / stables 5). The simulator
charges swap impact against the active liquidity and shares fees by liquidity, so a big position dilutes its own
fees. Idle: average share of the account held as USDC over the reviews. Waits: reviews where a bucket waited.

| Window | Deposit | Today: return / max DD / idle | Depth sizing: return / max DD / idle | Waits |
|---|---|---|---|---|
| Sep 2026 | 1k | +2.56% / 1.43% / 0.8% | +2.60% / 1.43% / 0.6% | 0 |
| Sep 2026 | 10k | +2.46% / 1.42% / 0.9% | +2.66% / 1.42% / 0.7% | 3 |
| Sep 2026 | 100k | +1.04% / 1.83% / 0.8% | +2.35% / 1.74% / 2.4% | 1,395 |
| Sep 2026 | 1M | +2.12% / 1.59% / 0.6% | +2.07% / 1.33% / 50.2% | 8,279 |
| Oct 2025 | 1k | −3.33% / 7.62% / 0.5% | −3.33% / 7.62% / 0.5% | 0 |
| Oct 2025 | 10k | −2.84% / 7.45% | −2.84% / 7.45% | 0 |
| Oct 2025 | 100k | −2.70% / 7.19% | −2.70% / 7.19% | 0 |
| Oct 2025 | 1M | −3.11% / 7.43% / 1.1% | −2.76% / 7.71% / 34.2% | 965 |
| Feb 2025 | 1k | −3.58% / 5.63% / 0.9% | −3.58% / 5.63% / 0.9% | 0 |
| Feb 2025 | 10k | −3.43% / 5.61% | −3.43% / 5.61% | 0 |
| Feb 2025 | 100k | −2.98% / 5.92% / 1.9% | −4.13% / 5.93% / 3.0% | 10 |
| Feb 2025 | 1M | −3.14% / 6.05% / 6.2% | −1.93% / 5.68% / 11.4% | 583 |

Reading:

- **Gate at 1k passes**: equal or better in all three windows. Nothing changes for today's account sizes.
- At 10k and 100k in September, depth sizing is clearly better (100k: +2.35% vs +1.04%). Today's sizing pushes the
  stables share into a 199k pool and pays for it in impact.
- At 1M the stables bucket cannot take its 50%: about half the account waits as USDC. Return is about the same in
  September (+2.07% vs +2.12%) with a lower drawdown, and better in both crash weeks. The waiting money is the cost
  of not having a deeper stables venue (phase 3).
- **One regression to understand before any cap goes up**: February 2025 at 100k, −4.13% vs −2.98%, with only 10
  waits and the same drawdown. The entry is split over more steps (43 swaps, 30 mints vs 39 / 22) in a falling
  week, and the order of entries across buckets changes. Not explained yet. It must be explained (and fixed or
  accepted with a reason) before `MAMORU_CAP_USDC` goes over 10k.

## Phases

**Phase 1 (this change, flag off).** Depth sizing in `decide` (`policy.depth`, `packages/decide/src/depth/`),
`DECIDE_WAIT_DEPTH` with the waiting amount per bucket, the freeze of spec 004 shown the same way, `FundingView`
`engine.waiting`, the app line. Operator env: `MAMORU_DEPTH=30,500,5` turns depth sizing on for the engine only (the
grants are built from the unchanged policy, so nothing about what a session allows changes); `MAMORU_CAP_USDC`
(whole USDC) replaces the constant at Start and in the session limits of new activations. Both absent: behaviour as
today, byte for byte (tested).

**Phase 2, raising the cap.**
1. Turn on `MAMORU_DEPTH` with the cap unchanged; watch the waiting lines and the review codes for a week.
2. Session limits sized for the larger cap. They are fixed at signing, so an account activated at 100 USDC cannot
   use a larger deposit until its owner approves larger limits once. That approval goes through the renew route with
   `extend` from #33 (one passkey tap, nothing moves), rebuilt on the current grants with limits from the new cap.
   The Base per-transaction gas cap (2^24) is already handled by that route (renewal first, then the rest).
3. A raised cap for new accounts first (e.g. 1,000, then 10,000), then the renew-to-raise row for existing ones.
4. Operator aggregate for the share rule across all accounts; QuoterV2 check of each entry swap.
5. More than one pool per bucket in the policy (BTC: cbBTC/USDC 0.3%), each with its own grants (enter-swap,
   enter-mint, manage-any, convert-any), added with the same extend route. Overflow order: by depth, then by fee.

**Phase 3.** A stables venue deeper than USDC/USDT 0.01% (Uniswap v4, Aerodrome, or lending): new contracts and
grants, its own review. Until then large stables shares wait as USDC, and the app says so.

## Interactions

- **Minimum deposit** (thread 16 Oct): below ~43 USDC engine gas exceeds fees in a calm month; the proposal is a 100
  USDC minimum. Depth sizing sets the ceiling of an entry; the minimum sets the floor of an account. Independent.
- **Loss control (spec 004)**: a frozen bucket waits the same way a bucket short of depth does, with its own code and
  line. Exits are not sized by this rule yet; an exit swap above `swapRoom` should be split over reviews (spec 004
  already proposes it).
- **Yield ledger (#129)**: waiting USDC earns nothing; the ledger should report it so the cost of the stables
  bottleneck is visible.

## Decisions for Ot

1. Thresholds to start with: 30 bps impact (5 for stables) and 5% of active liquidity.
2. Large stables shares: wait as USDC (built), or spread the overflow over the other buckets (changes the risk mix:
   more BTC and ETH than the policy says). Recommended: wait, and add a stables venue in phase 3.
3. Cap steps after phase 1: 1,000, then 10,000, after the February 100k regression is explained.
