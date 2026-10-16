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
  `maxShareBps` of the pool's liquidity (the smaller of the active and the window mean, at the TWAP; see Manipulation).
- `swapRoom` / `sellRoom`: the largest sale of savings (for an entry) or of the volatile token (for selling back an
  excess) whose average execution impact is at most half of `maxImpactBps` against that liquidity, the pool fee aside
  (constant-liquidity, linearised: Δ1 = b·L·√P, Δ0 = b·L/√P, b the impact as a fraction). It does not see liquidity
  beyond the current tick range, so the engine also checks the real QuoterV2 quote (which crosses ticks) before
  sending an entry swap, and refuses it with `EHG_SWAP_IMPACT_OVER_LIMIT` when it is worse than the limit.
- Depth shrinks the mint, never the volatile the bucket keeps for it: a sale of idle volatile is judged against the
  unsized entry and capped at `sellRoom`, so depth sizing can never sell more than before.
- The next entry of the bucket is `min(gap, available, shareRoom, swapRoom / volatileShare)`. If that is under
  `minEntry`, nothing is proposed for the bucket. Its shortfall stays as USDC with reason `DECIDE_WAIT_DEPTH` and the
  amount, and the next bucket in the order gets the entry.
- What is placed is placed in several steps (a partial fill per review), each one re-checked against the pool at
  its own block. The part that does not fit is reported as waiting at once, not only when the bucket is blocked.
- What waits is reported beside the decision (`Decision.waiting`), outside its premise hash and id: the amounts move
  with every price, and inside the hash they would defeat the dedupe of repeated holds.

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
fees. Idle: average share of the account held as USDC over the reviews. Waits: reviews where a bucket waited for depth (including the remainder of a partial entry).

| Window | Deposit | Today: return / max DD / idle | Depth sizing: return / max DD / idle | Waits |
|---|---|---|---|---|
| Sep 2026 | 1k | +2.56% / 1.43% / 0.8% | +2.66% / 1.43% / 0.5% | 11 |
| Sep 2026 | 10k | +2.46% / 1.42% / 0.9% | +2.72% / 1.42% / 0.5% | 28 |
| Sep 2026 | 100k | +1.04% / 1.83% / 0.8% | +2.35% / 1.74% / 2.5% | 1,500 |
| Sep 2026 | 1M | +2.12% / 1.59% / 0.6% | +2.06% / 1.31% / 50.5% | 8,641 |
| Oct 2025 | 1k | −3.33% / 7.62% / 0.5% | −3.33% / 7.62% / 0.5% | 0 |
| Oct 2025 | 10k | −2.84% / 7.45% / 0.6% | −2.84% / 7.45% / 0.6% | 0 |
| Oct 2025 | 100k | −2.70% / 7.19% / 0.6% | −2.70% / 7.19% / 0.6% | 0 |
| Oct 2025 | 1M | −3.11% / 7.43% / 1.1% | −2.72% / 7.70% / 34.3% | 1,009 |
| Feb 2025 | 1k | −3.58% / 5.63% / 0.9% | −3.61% / 5.62% / 0.9% | 2 |
| Feb 2025 | 10k | −3.43% / 5.61% / 1.0% | −3.44% / 5.61% / 0.9% | 5 |
| Feb 2025 | 100k | −2.98% / 5.92% / 1.9% | −3.73% / 6.07% / 2.3% | 78 |
| Feb 2025 | 1M | −3.14% / 6.05% / 6.2% | −2.40% / 5.74% / 15.3% | 1,009 |

Depth sizing as built: read at the TWAP, liquidity = the smaller of the active and the window's (the Lab uses the
window minimum, harsher than the harmonic mean the live code reads), swaps sized to half the impact budget.

Reading:

- **At 1k the strict gate misses by 0.03 pp in February 2025** (−3.61% vs −3.58%, max drawdown 5.62% vs 5.63%), and
  is better in September (+2.66% vs +2.56%) and equal in October. The two waits are real: at the end of January 2025
  the USDC/USDT 0.01% pool's liquidity over the 30-minute window fell to 0.9% of its spot value (a young, thin pool),
  and the conservative liquidity rule held the entry. That is the case the rule exists for; whether 0.03 pp in a crash
  week is an acceptable price for it is Ot's call (decision 4 below).
- At 10k and 100k in September depth sizing is clearly better (100k: +2.35% vs +1.04%): today's sizing pushes the
  stables share into a 199k pool and pays for it in impact.
- At 1M the stables bucket cannot take its 50%: about half the account waits as USDC. Return about the same in
  September with a lower drawdown, better in both crash weeks.
- **February 2025 at 100k is worse** (−3.73% vs −2.98%, drawdown 6.07% vs 5.92%). The entry is split over more steps
  in a falling week and the order of entries across buckets changes. Not explained yet. It must be explained (and
  fixed or accepted with a reason) before `MAMORU_CAP_USDC` goes over 10k.

## Manipulation

Slot0, the active liquidity and a quote at the block we read can all be moved by a swap or by liquidity added in that
same block. Nothing in this rule trusts them alone:

- `depthOf` prices the range and the share at the **TWAP tick**, and reads liquidity as the smaller of the active and
  the window's **harmonic-mean liquidity** (`secondsPerLiquidityCumulativeX128` from the same `observe` call as the
  TWAP). Liquidity added for one block adds no room; a pushed price moves no room. No TWAP or no mean: no room.
- The existing EHG gate refuses any proposal when the spot tick is more than `maxTwapDeviationTicks` (100) from the
  TWAP, or the TWAP is unavailable (`EHG_PRICE_DIVERGENCE`, `EHG_TWAP_UNAVAILABLE`).
- The engine reads the TWAP again at the block it quotes. A quote under what the input buys at the TWAP, after fee,
  less `maxImpactBps`, is refused before anything is sent (`EHG_SWAP_IMPACT_OVER_LIMIT`), and that floor is the router
  minimum when it is above the usual slippage minimum. Whatever the price does before inclusion, the swap does not
  execute worse than the limit against the TWAP; if it would, it reverts.
- Swaps are sized to half the impact budget, so the other half is headroom for the price to move until inclusion.
- Limit: with depth sizing off (today's live path) the engine's minimum out still comes from the spot quote with
  `slippageBps`; this change leaves that path byte-identical, and the EHG deviation gate is what protects it today.

Tests: every pool's slot0 pushed 2,000 ticks inside the block, TWAP unchanged: the review holds with
`EHG_PRICE_DIVERGENCE`. A pushed spot and 1,000x flash liquidity leave the depth room unchanged. A quote 1% under the
TWAP price is under the floor.

## Phases

**Phase 1 (this change, flag off).** Depth sizing in `decide` (`policy.depth`, `packages/decide/src/depth/`),
`DECIDE_WAIT_DEPTH` with the waiting amount per bucket, the freeze of spec 004 shown the same way, `FundingView`
`engine.waiting`, the app line. Operator env: `MAMORU_DEPTH=30,500,5` turns depth sizing on for the engine only (the
grants are built from the unchanged policy, so nothing about what a session allows changes); `MAMORU_CAP_USDC`
(whole USDC) replaces the constant at Start and in the session limits of new activations. A cap above 100 USDC is
refused at boot unless `MAMORU_DEPTH` is set. Accounts already active keep the session limits they signed: a
deposit above them is refused by the engine's pre-check before anything is sent, until the owner approves larger
limits (phase 2). Both absent: behaviour as today, byte for byte (tested).

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
4. Accept the 0.03 pp at 1k in February 2025 as the price of the conservative liquidity rule, or relax it (e.g. the
   harmonic mean only, without the minimum with spot).
