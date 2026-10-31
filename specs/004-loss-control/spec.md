# 004: Loss control in decide

Ticket: otto/mamoru#101. Related: #105 (objectives audit), #56 (protection presets, Lab first), #54 (rule families),
#55 (stables venue), #127 (capless sizing), #128 (idle with a reason), #129 (yield ledger), #5 (manage-any lost at
activation). Research: noema `1-projects/mamoru/research/capital-protection/` and
`1-projects/mamoru/product/capital-protection-roadmap.md`. Status: design, no code. Branch `spec/101-loss-control`.

## Why

Ot, 4 Oct: the app must control losses. On `main` nothing in `packages/decide` leaves a position because of a loss:

- `Observation.intents.exitRequested` (`packages/decide/src/types.ts:20`) is never read by `decide()`.
- `GateVerdict` has `EXIT` and no gate returns it. `DECIDE_EXIT`, `RISK_INCIDENT_EXIT`, `EXIT_*` and
  `EHG_NO_GO_OVERRIDDEN_BY_EXIT` exist in `packages/domain/src/reason-codes.ts` with no producer.
- The only price guard is the TWAP deviation gate (`gates/index.ts`, 100 ticks over 30 min). It **blocks** an
  operation on a bad price. It never exits, and in a fast fall it also blocks the re-range.
- `conservadorLiveV2` lists `packaging:price-impact`, `packaging:tvl`, `packaging:depeg` in `shadow`: nothing
  computes them.
- What reacts to price today is the re-range: out of range or within 10% of an edge, the position is closed and
  re-minted around the new price. In a falling market that sells the volatile token low and buys it back
  (`rerange` + `ratioConvertOf` + mint): it realizes the loss and stays exposed.

Spec 001 already designed the exit path (`ExitRequest`, Risk Monitor gate, `EXIT_PENDING`, `OP_PREEMPTED_BY_EXIT`,
constitution V: an exit asked by a higher gate is not cancelled by a lower one). This spec gives the Risk Monitor
its rules, per bucket, with typed reasons and thresholds that the Lab calibrates before a live policy enables them.

## What is not promised

A loss rule is a target, never a guarantee (roadmap B2, copy rule #58). A gap (price moves through the threshold
between two reviews, or the exit swap pays impact) can make the realized loss larger than the threshold. The app says
"loss limit" and "target", never "protected", "guaranteed" or "insured".

## Measured exposure today (Lab, 15 Oct)

Production `decide` replayed on recorded and backfilled Base history (`packages/backtest`, `conservador-live-v2`,
deposit 1,000 USDC, review every sample, session limits enforced). Numbers are from the simulator, which is calibrated
for fees on wide ranges and over-estimates fees on the 40-tick stable range by ~22% (lab note 2026-10-02).

Data that exists:

| Dataset | Window | Samples | Source |
|---|---|---|---|
| `base-30d-5m` | 2026-09-01 23:15 .. 2026-10-01 23:15 UTC | 8,641 at 5 min | archive backfill, 6 registry pools |
| `base-2025-10-crash-10m` | 2025-10-06 23:55 .. 2025-10-13 23:55 UTC | 1,009 at 10 min | backfilled 15 Oct for this spec (public archive RPC) |
| `base-2025-02-crash-10m` | 2025-01-29 23:55 .. 2025-02-05 23:55 UTC | 1,009 at 10 min | backfilled 15 Oct for this spec (public archive RPC) |
| D1 `pool_snapshots` | from 2026-10-02 00:43 UTC | live collector | not exported to a dataset yet (task LC-T2) |

Not available on Base at all: the USDC depeg of March 2023 (Base mainnet opened in August 2023; cbBTC in September
2024). It has to be replayed as an overlay (Lab plan, LC-L4).

Market in each window (prices from the pools' ticks):

| Window | cbBTC: max drawdown, worst 1 h, worst 24 h | WETH: max drawdown, worst 1 h, worst 24 h | 24 h realized vol, p90 (BTC / ETH) | USDT off peg, max |
|---|---|---|---|---|
| Sep 2026 | 8.2%, -2.4%, -5.1% | 10.0%, -2.8%, -8.6% | 45% / 46% | 22 bps |
| Oct 2025 | 17.4%, **-11.8%**, -15.3% | 23.9%, **-10.1%**, -17.6% | 205% / 179% | 5 bps |
| Feb 2025 | 13.3%, -4.7%, -9.0% | 31.1%, **-16.7%**, -25.1% | 87% / 352% | 39 bps |

`conservador-live-v2` as it runs today:

| Window | Deposit | End (net of gas) | Hold the entry mix | Max drawdown | Worst week | Lowest point vs hold | Gas | Re-ranges | Reviews blocked by `EHG_PRICE_DIVERGENCE` |
|---|---|---|---|---|---|---|---|---|---|
| Sep 2026 (30 d) | 1,000 | 1,025.58 (+2.56%) | 1,025.15 | 1.43% | 1.09% | -0.54% | 0.73 | 10 | 4 |
| Sep 2026 (30 d) | 100 | 101.73 (+1.73%) | 102.51 | 2.09% | 1.64% | n/a | 0.57 | 12 | 3 |
| Oct 2025 (7 d) | 1,000 | 966.71 (-3.33%) | 979.82 | 7.62% | 7.57% | -3.12% | 3.95 | 12 | 12 |
| Oct 2025 (7 d) | 100 | 94.59 (-5.41%) | 97.98 | 8.96% | 8.94% | -4.56% | 2.48 | 8 | 12 |
| Feb 2025 (7 d) | 1,000 | 964.16 (-3.58%) | 980.76 | 5.63% | 4.98% | -1.86% | 2.57 | 15 | 11 |

Reading:

- With 50% in a stable pool and 10% in ETH, a 17-24% crash costs the account about 8% at the worst point. The loss
  against simply holding the entry mix (-1.3 pp at 1,000, -3.4 pp at 100) is the re-range chasing the fall: 12
  re-ranges in one week, each one selling low and re-minting, and gas five times a normal month.
- The core of the October 2025 crash was one hour (-11.8% BTC, -10.1% ETH). No rule on a 30-minute TWAP exits before
  that hour. A 24 h trend rule at -7% (BTC) / -9% (ETH) fires once, at 21:15-21:25 on 10 Oct, which was the trough;
  prices ended the window 11.5% (BTC) and 13.7% (ETH) above the exit price. Tighter thresholds fire earlier in October
  (-5% ETH: 8 Oct, then a further -18.9%) but also fire in calm September (-4% / -5%: 15 Sep, followed by +11-12%).
  In February 2025 the same rule fired at the BTC trough (window end +5% above the exit) but early for ETH (2 Feb
  18:45, then a further -19.5%, window end -5%). **On this data a pure 24 h trend exit is a coin flip: it does not separate the onset of a crash from an ordinary
  dip.** What clearly helps in both windows is not chasing: stop re-ranging into a fall (`RISK_REGIME_VOL` freeze,
  `RISK_EXIT_NOT_RERANGE`), which the September window never triggers (vol p90 45%) and October triggers for the whole
  crash (vol p90 179-205% in October, 87-352% in February).
- The 100-tick TWAP gate blocked 12 reviews in the October week (max deviation 723 ticks on cbBTC, 465 on WETH) and
  11 in February (1,468 ticks on WETH).

These are single windows replayed once. They rank nothing on their own (lab note 2026-10-02); they set the
thresholds' starting points and show which rules the Lab sweep must kill or keep.

## Design

### Where it lives

A Risk Monitor step in `decide`, before every other step (constitution V order: Purga, Risk Monitor, EHG, ENY,
Strategy). `decide` stays pure: everything a rule needs comes in the observation, and every state change comes out in
the decision. The engine Durable Object persists the guard state and feeds it back next review.

```
observe -> riskMonitor(obs.guard, policy.guards) -> per bucket: OK | FREEZE | EXIT | PARKED
        -> exit legs (if any bucket is EXIT) pre-empt rerange, harvest, reduce, idle convert and entries
        -> allocate() skips FREEZE and PARKED buckets; their share waits in USDC with a reason (#128)
```

### Bucket states

| State | Entries | Re-range | Harvest | Capital inside |
|---|---|---|---|---|
| `OK` | yes | yes | yes | stays |
| `FREEZE` | no | no (the position is left as it is) | yes, fees only | stays |
| `EXIT` | no | no | collect only, as part of the close | close to the Safe, then convert to USDC |
| `PARKED` | no | n/a | n/a | none; the bucket's share waits as USDC |

`EXIT` becomes `PARKED` when the bucket holds no position and no idle volatile token above dust. `PARKED` goes back to
`OK` only through the re-entry rule of its cause (below). Other buckets keep their own state: an exit in `risk` does
not touch `stables`, and the parked share is **not** redistributed to the other buckets (it waits in USDC; changing
that is decision D4).

### Guardrails

Every rule is evaluated on the TWAP over the policy window (30 min today), never on the spot tick of one block, so
that a single manipulated block cannot fire an exit. Thresholds are policy parameters per bucket, versioned with the
policy (constitution VI: engineering parameters, no scenario asserts their value). Initial values below are starting
points for the Lab sweep, chosen so that the September 2026 window produces zero firings.

| Code (Risk Monitor) | Bucket | Metric | Fires | Initial threshold | Action |
|---|---|---|---|---|---|
| `RISK_DEPEG_PAIRED` | stables | USDT/USD from the oracle, and the pool TWAP price of USDT in USDC | both below peg by more than X for T | X = 50 bps, T = 30 min: `FREEZE`. X = 100 bps, T = 30 min: `EXIT` | close and convert USDT to USDC within the impact limit |
| `RISK_DEPEG_SAVINGS` | all | USDC/USD from the oracle | below peg by more than X for T | X = 50 bps, T = 30 min | `FREEZE` every bucket; no conversion into or out of USDC (decision D2) |
| `RISK_DRAWDOWN_POSITION` | btc-usdc, risk | bucket lineage value (positions + idle volatile + fees collected) in USDC, against the USDC put into the bucket since its last `PARKED`/first entry, net of what left it | loss over X | btc 10%, risk 12% | `EXIT` |
| `RISK_REGIME_TREND` | btc-usdc, risk | 24 h change of the TWAP price | fall over X | btc 7%, risk 9% | `EXIT`. Lab-gated: on October 2025 it fired at the trough (see above); it ships only if LC-L1..L3 pass |
| `RISK_REGIME_VOL` | btc-usdc, risk | realized volatility over 24 h, annualized, from TWAP samples | over X | btc 80%, risk 100% | `FREEZE` |
| `RISK_EXIT_NOT_RERANGE` | btc-usdc, risk | out of range on the down side and `RISK_REGIME_TREND` at half its threshold | both | btc 3.5%, risk 4.5% | `EXIT` instead of the re-range |
| `RISK_DRAWDOWN_ACCOUNT` | account | account value in USDC against net deposits (deposits minus withdrawals) | loss over X | 10% (user-chosen later, #56) | `EXIT` on every volatile bucket; stables stay unless a depeg rule says otherwise |
| `RISK_POOL_TVL_DROP` | all | pool TVL (token balances of the pool, in USDC at the TWAP) against 24 h ago, held for T | fall over X for T = 30 min | 50%: `FREEZE`. 80%: `EXIT` | close; convert only if the impact rule allows |
| `RISK_ORACLE_DIVERGENCE` | all | pool TWAP price against the oracle | apart by more than X for T | volatile 150 bps, stables 50 bps, T = 15 min | `FREEZE`; after 60 min with capital inside, close without converting |
| `RISK_ORACLE_STALE` | all | oracle `updatedAt` | older than its heartbeat + margin | feed heartbeat x 1.5 | the oracle rules cannot pass: `FREEZE` new entries only, no exit on stale data |
| `RISK_PRICE_IMPACT` | all | QuoterV2 quote for the exit swap against the TWAP price | impact over X | volatile 100 bps, stables 20 bps | not a trigger: splits the exit convert over reviews (`EXIT_PARTIAL_IMPACT`) |
| `RISK_DATA_INSUFFICIENT` | all | history for a rule is missing (fewer than N samples in the window) | missing | n/a | that rule abstains, the bucket cannot leave `PARKED` on it; never an exit |

Notes:

- **Cost basis is per bucket, not per tokenId.** A re-range burns the position and mints a new tokenId. A basis per
  position would reset at every re-range, and a falling market that re-ranges three times would never reach the
  threshold. The basis is the bucket's lineage: USDC that entered the bucket (entries, top-ups) minus USDC that left it
  (reduce, idle convert, exit), from the journal.
- **Why active liquidity is not the TVL metric.** In September 2026 the in-range liquidity of the stables pool fell
  below 0.1% of its median at some samples and the volatile pools' fell to 30-37% of their median (16-22% in the
  October 2025 week): liquidity leaves the
  current tick all the time. TVL is read as `balanceOf(pool)` of both tokens (two calls per pool per snapshot).
- **Drawdown vs hold** (IL) is computed per position and per account and reported (#129 ledger), but it is not an
  exit trigger by itself: an in-range position behind its hold is the cost of fees, not a loss signal
  (il-mitigation research). It drives `RISK_EXIT_NOT_RERANGE`: below the range in a falling market, stop chasing.
- **Depeg direction.** In the USDC/USDT pool only the ratio is visible: a USDC depeg looks like USDT going up. The
  oracle tells which side moved. Both rules require oracle and pool to agree, except `RISK_DEPEG_SAVINGS`, which reads
  the oracle alone and only ever freezes.

### Exit path

An exit of a bucket is two or more engine operations, each one review, each under a grant the account already holds
when #5 is fixed:

1. `close_position` (existing journal kind, today used for the re-range): `decreaseLiquidity(all)` + `collect` to the
   Safe + `burn`, grant `manage-any:<pool>`. Code `DECIDE_EXIT`, cause the `RISK_*` code.
2. `exit_convert`: volatile token to USDC through the same pool, `exactInputSingle` with `recipient = Safe`, grant
   `convert-any:<pool>`. `amountOutMinimum` = QuoterV2 quote at the execution block minus `slippageBps`. A minimum
   from the TWAP would revert in a crash, when spot sits below the TWAP. The TWAP only bounds when the leg may run
   (below). Repeated while the bucket holds
   volatile above dust; each leg is sized so the quoted impact stays under `RISK_PRICE_IMPACT`
   (`EXIT_PARTIAL_IMPACT` on the decision while legs remain).

Precedence (FR-LC-003): an exit leg goes before re-range, harvest, reduce, idle convert and entries, and pre-empts an
unsigned operation (`OP_PREEMPTED_BY_EXIT`).

Several buckets in `EXIT` at once (for example `RISK_DRAWDOWN_ACCOUNT`): legs run one per review, bucket with the
largest loss against its basis first, policy order on ties. `allocate()`, `reduceOf()`, `idleConvertOf()` and
`ratioConvertOf()` skip a bucket in `EXIT` exactly as they skip `FREEZE` and `PARKED`.

Busy slot: today `decide` returns `DECIDE_SLOT_BUSY` before it looks at anything when `obs.slot` is set. With guards,
the Risk Monitor runs first; if it asks for an exit and the slot holds an operation that is not yet signed, the
decision is the exit and the engine discards the slot's operation with `OP_PREEMPTED_BY_EXIT` (spec 001). A signed
operation is never pre-empted: the exit waits for it (`EXIT_PENDING` with `OP_SLOT_BUSY`). `Observation.slot` gains
`signed: boolean`.

Session budget: `SessionObs` carries no usage today; the engine learns a spent grant only when the bundler refuses.
`SessionObs` gains `usesLeft` (from the journal count against `usageLimit`), and an exit leg whose grant has none left is
`EXIT_PENDING` with `SESSION_USAGE_SPENT` before it is built.

EHG on an exit (constitution V, spec 001 FR-DEC-005):

- The close leg passes a TWAP-deviation NO GO (`EHG_NO_GO_OVERRIDDEN_BY_EXIT`): it does not swap, so a manipulated
  price only changes the split of tokens returned.
- The convert leg: constitution V says an exit goes even when the EHG says NO GO. Applied literally, the swap would
  run at any spot the block offers, which is what a manipulator wants. Proposed (decision D6, a constitution V
  amendment, not a local override): the convert leg runs while `|tick - twap|` is under
  `execution.exitMaxTwapDeviationTicks` (initial 500); above that it waits (`EXIT_SWAP_WAIT_TWAP`) with the volatile
  token held in the Safe, out of the pool. Until Ot decides D6, the literal constitution V applies. In the September window the 100-tick gate fired at 23 samples (cbBTC) and 42 (WETH), max
  167 and 286 ticks: a crash is exactly when the 100-tick gate would block a full exit.
- Session missing, expired or usage spent: the exit stays `EXIT_PENDING` with that cause and the app asks for the one
  approval (#128). The owner can always leave by hand (walkaway kit).

### Re-entry and cooldown

| Cause | Re-entry when (all of) | Minimum time parked |
|---|---|---|
| `RISK_REGIME_TREND`, `RISK_EXIT_NOT_RERANGE` | 24 h change above -2%, 24 h volatility under the `RISK_REGIME_VOL` threshold, TWAP within `maxTwapDeviationTicks` | 72 h |
| `RISK_DRAWDOWN_POSITION` | same as trend | 72 h |
| `RISK_DEPEG_PAIRED`, `RISK_DEPEG_SAVINGS` | oracle and pool within 20 bps of peg for 72 h | 72 h |
| `RISK_POOL_TVL_DROP` | TVL back above 70% of its pre-drop level for 72 h | 72 h |
| `RISK_ORACLE_DIVERGENCE` | within threshold for 24 h | 24 h |
| `RISK_DRAWDOWN_ACCOUNT` | owner action only (one tap; no new signature) | n/a |

Whipsaw bound: at most 2 automatic exits per bucket in 30 days; the third trigger parks the bucket until the owner
resumes it (`RISK_EXIT_BUDGET_SPENT`). Re-entry is an ordinary target-weights entry from the parked USDC.

### Observation and policy additions (no code here)

`Observation.guard` (built by the engine from the journal, the D1 ledger of #129 and the snapshot loop of spec 003):

- per bucket lineage: `basisUsdc` (USDC in minus USDC out since first entry or last `PARKED`), `feesCollectedUsdc`;
  per position: `mintAmounts` (for vs-hold);
- account: `netDepositsUsdc`;
- per pool: `twap24hAgoTick`, `realizedVol24hBps` (from TWAP samples), `tvlUsdc` and `tvl24hAgoUsdc`, `samples24h`;
- per token: oracle answer and `updatedAt` (Chainlink USDC/USD, USDT/USD, BTC/USD or cbBTC/USD, ETH/USD on Base;
  registry entries with pinned code hashes, read-only);
- per bucket: `{ state, cause, since, exits30d }` persisted by the engine DO.

`PolicyVersion.guards` (new, optional; absent = today's behaviour byte for byte):

```
guards: {
  mode: 'shadow' | 'enforce'
  byBucket: Record<BucketId, { depegFreezeBps?, depegExitBps?, depegWindowS?, positionLossBps?, trendFallBps?,
                               volFreezeBps?, tvlFreezeBps?, tvlExitBps?, oracleDivergenceBps?, exitImpactBps?,
                               reentry: { minParkedS, trendAboveBps, peg: { bps, holdS } } }>
  account: { lossBps?, ownerResume: true }
  exitsPer30d: 2
}
execution.exitMaxTwapDeviationTicks
```

`mode: 'shadow'` evaluates every rule and writes the would-be codes to `Decision.shadow` without acting. That is the
first live step (constitution VI keeps Packaging numbers in shadow until #56 calibrates them).

`Decision` gains `guards: { bucket, state, code, metric, threshold }[]`, so the app and `/ops` read the same facts the
engine acted on.

### Session grants: what is already allowed

| Action | Grant | Live accounts today |
|---|---|---|
| Close a position to the Safe (decrease all, collect, burn) | `manage-any:<pool>` | stables pool only. cbBTC and WETH buckets lose `manage-any` at activation (#5): **no automatic exit is possible in the two volatile buckets until #5 lands.** |
| Convert volatile to USDC in the bucket's pool | `convert-any:<pool>` (per-call cap, no cumulative cap; 64 uses per session, shared with harvest and idle convert) | same as above (#5) |
| Same, per position | `manage:<tokenId>` (cumulative convert cap) | only where the owner activated the id |
| Rotate USDC to USDT (USDC depeg, if D2 chooses it) | `enter-swap:pool:USDC/USDT/100` (cumulative cap = 100% of the account cap) | yes |
| Read oracle, pool balances, QuoterV2 | none (reads) | n/a |
| Exit through a deeper pool or another fee tier (e.g. WETH/USDC 0.05%) | **new grant**: fee and tokens are pinned per pair | no |
| Park in lending (Aave, Morpho) instead of idle USDC | **new grants**, registry entries, adversarial session scenarios (#55) | no |

Caps: per-call caps are bps of `LIVE_CAP_USDC` priced at activation. A whole-bucket exit fits one or two calls at
today's cap. #127 removes the cap: its cap formula must keep a full exit of any bucket executable in at most N calls
inside the usage limit (FR-LC-011), or the exit stops at `POLICY_DENIED_AMOUNT`.

### Interaction with #127 (capless sizing) and #128 (idle with a reason)

- One module computes pool health (TVL, quoted impact, share of in-range liquidity) for both: #127 uses it to size
  entries (`WAIT_DEPTH`), loss control uses it to freeze, exit and split exits. Same metric, same numbers in `/ops`.
- `FREEZE`, `PARKED` and pending exit legs produce the same "waiting" record as #128: `{ amount, bucket, code,
  condition, nextCheckAt }`. `allocate()` returns them instead of silently skipping a bucket.
- A parked share is never re-routed by #127's overflow to another pool of the same bucket while the cause is a market
  rule (trend, drawdown, depeg). It may be when the cause is pool-specific (TVL drop, oracle divergence) and the other
  pool is healthy.

### How the user sees it

Per bucket on Home, from `Decision.guards` and the #128 waiting record. Plain language, no codes:

| State | Line |
|---|---|
| `FREEZE` (vol) | "BTC is moving fast. Mamoru is not adding to the BTC pool until it calms down. Your position stays as it is." |
| `EXIT` in progress | "BTC fell 8% in a day. Mamoru is moving your BTC share to USDC (step 1 of 2)." |
| `PARKED` | "40.10 USDC parked since 14:05 because BTC fell 8% in a day. It goes back in when BTC stops falling, not before Friday." |
| `EXIT_PENDING` session | "Mamoru wants to move your BTC share to USDC and needs one approval." with the action |
| Account loss limit | "Your account reached the loss limit (-10% of what you put in). BTC and ETH shares are in USDC. Resume when you want." |
| USDC depeg | "USDC is trading under one dollar. Mamoru has stopped all moves until it recovers." |

History shows each exit leg with the trigger, the measured value and the threshold ("24 h change -8.3%, limit -7%").
The risk page states the gap: the limit is a target and a fast move can pass it.

## Requirements

- **FR-LC-001.** `decide` evaluates the Risk Monitor before any other step when `policy.guards` is present. Absent, the
  decision is byte-identical to today.
- **FR-LC-002.** Every rule reads TWAP or oracle values, never the spot tick alone.
- **FR-LC-003.** An exit leg has precedence over every other proposal and pre-empts unsigned operations, including one
  that holds the slot. Several exiting buckets go largest loss first.
- **FR-LC-004.** A bucket in `FREEZE`, `EXIT` or `PARKED` gets no entry, re-range, reduce, idle convert or ratio
  convert other than its own exit legs.
- **FR-LC-005.** The close leg passes a TWAP-deviation NO GO; the convert leg waits above
  `exitMaxTwapDeviationTicks`.
- **FR-LC-006.** Every exit leg carries the `RISK_*` cause, the metric and the threshold in the journal and in the
  decision.
- **FR-LC-007.** Missing history or a stale oracle never causes an exit (`RISK_DATA_INSUFFICIENT`, `RISK_ORACLE_STALE`).
- **FR-LC-008.** `RISK_DEPEG_SAVINGS` never sells or buys USDC (unless D2 decides otherwise).
- **FR-LC-009.** Re-entry follows the table per cause, and the automatic exit budget per bucket.
- **FR-LC-010.** `mode: 'shadow'` acts on nothing and records every would-be code.
- **FR-LC-011.** The session cap formula of any policy that enables guards lets a whole-bucket exit run in at most N
  convert calls within the usage limit.
- **FR-LC-013.** Drawdown is measured on the bucket lineage, so a re-range never resets it.
- **FR-LC-014.** An exit leg whose grant has no uses left is `EXIT_PENDING` with `SESSION_USAGE_SPENT` before it is
  built.
- **FR-LC-015.** The convert leg's `amountOutMinimum` comes from a quote at the execution block, never from the TWAP.
- **FR-LC-012.** Every amount waiting because of a guard is visible to the owner with a reason and the condition it
  waits for (#128).

## New reason codes

`RISK_DEPEG_PAIRED`, `RISK_DEPEG_SAVINGS`, `RISK_DRAWDOWN_POSITION`, `RISK_DRAWDOWN_ACCOUNT`, `RISK_REGIME_TREND`,
`RISK_REGIME_VOL`, `RISK_EXIT_NOT_RERANGE`, `RISK_POOL_TVL_DROP`, `RISK_ORACLE_DIVERGENCE`, `RISK_ORACLE_STALE`,
`RISK_PRICE_IMPACT`, `RISK_POOL_TVL_FLOOR`, `RISK_POOL_TVL_UNREAD`, `RISK_POOL_VOLUME_LOW`, `RISK_POOL_STATS_UNREAD`, `RISK_DATA_INSUFFICIENT`, `RISK_EXIT_BUDGET_SPENT`, `SESSION_USAGE_SPENT` (used by the
simulator today, not yet in the domain list), `EXIT_LOSS_CONTROL` (ExitRequest cause),
`EXIT_PARTIAL_IMPACT`, `EXIT_SWAP_WAIT_TWAP`, `BUCKET_FROZEN`, `BUCKET_PARKED`, `BUCKET_REENTERED`.

## Lab plan

The simulator replays production `decide`, so each rule is tested by enabling it in a `chain: 'fork'` policy
(`conservador-lab-guards-v1`) and replaying. Additions to the simulator: `observe()` fills `Observation.guard` from the
dataset (TWAP history, TVL from pool balances, a synthetic oracle = TWAP of a reference pool unless a feed path is in
the dataset); metrics per bucket: guard firings, realized loss at exit against the threshold (the gap), days parked,
exits per bucket, return against the unguarded baseline.

| Id | Data | Pass | Fail |
|---|---|---|---|
Each row passes only if every condition holds; anything else fails. "Trough" = the lowest TWAP price of the bucket's
pool in the window.

| Id | Data | Pass (all of) |
|---|---|---|
| LC-L1 calm | `base-30d-5m` (Sep 2026), 5 start offsets | zero `EXIT`; reviews in `FREEZE` <= 5%; return >= baseline - 0.10 pp at every offset |
| LC-L2 sharp fall | `base-2025-10-crash-10m` | first exit leg within 2 reviews of the rule's threshold crossing; exit price >= 1.02 x trough (not at the bottom); account max drawdown <= 0.7 x baseline; realized bucket loss <= threshold + 3 pp; <= 2 exits per bucket; net at window end >= baseline - 1 pp |
| LC-L3 sharp fall | `base-2025-02-crash-10m` | same as LC-L2 |
| LC-L4 USDC depeg | overlay: mainnet USDC/USDT 0.01% and Chainlink USDC/USD, 2023-03-09 .. 2023-03-16, mapped onto `pool:USDC/USDT/100` | `RISK_DEPEG_SAVINGS` freezes every bucket within 2 reviews of the crossing; zero swaps while oracle USDC/USD < 0.995; first re-entry >= 72 h after the oracle is back within 20 bps; end value (USD) >= baseline |
| LC-L5 USDT depeg, no recovery | synthetic: USDT to 0.95 over 6 h | stables bucket fully in USDC by window end; realized loss <= deviation at the crossing + `exitImpactBps` + 10 bps |
| LC-L6 manipulation | Sep window + one sample with spot -15% and TWAP intact | zero `FREEZE` and zero `EXIT` caused by that sample |
| LC-L7 TVL drain | Sep window, stables pool balances -85% held 2 h | `FREEZE` after the 50% drop has held 30 min; `EXIT` after 80% has held 30 min; no convert leg with quoted impact > `exitImpactBps`; same drain held 10 min: no state change |
| LC-L8 no session | LC-L2 with `sessionRenewal: 'once'` past expiry, and LC-L2 with `convert-any` uses at 0 | `EXIT_PENDING` with `SESSION_EXPIRED` / `SESSION_USAGE_SPENT` at every review until the window ends; zero operations |
| LC-L9 whipsaw | LC-L2 + LC-L3 with thresholds at half | <= 2 automatic exits per bucket per 30 days; the next trigger yields `RISK_EXIT_BUDGET_SPENT` |

Then, per #101 acceptance: a tape scenario where the rule fires and the position ends as USDC in the Safe, and a fork
e2e of the same tape on a policy version that enables it.

Known simulator limits: one sample every 5-10 min against a 20 s live review (the Lab sees larger gaps than live
would), single-range swap impact, no MEV, oracle synthetic unless the feed is backfilled.

### Lab windows and the sweep (16 Oct)

Thirteen Base windows in `packages/backtest/src/windows.ts`, with a fixed TRAIN/TEST split. TRAIN holds the three
windows the thresholds above were read from, so it is in-sample by construction. A rule is tuned on TRAIN and judged
once on TEST. `bun packages/backtest/cli/windows.ts manifest` writes the market in each window next to the datasets.

| Split | Windows |
|---|---|
| TRAIN | sep2026 (calm), oct2025, feb2025, mar2025, aug2024 (crashes; aug2024 has no cbBTC pool and runs only WETH policies), dec2024 (rally), calm-2025-09, calm-2026-04 (drawn) |
| TEST | apr2025 (tariff crash), may2025 (ETH +37% week), jun2025 (calm BTC, WETH -25% dip), calm-2026-05 (drawn), feb2026 (USDT 176 bps under USDC inside a crash) |

`conservador-live-v2` on every window, review every sample, session limits enforced (mean over windows):

| Split | Deposit | Windows | Mean return | Mean vs hold | Worst return | Worst max drawdown | Worst day |
|---|---|---|---|---|---|---|---|
| TRAIN | 1,000 | 7 | -0.33% | -0.36% | -3.58% | 7.62% | 6.78% |
| TRAIN | 100,000 | 7 | -0.23% | -0.26% | -5.58% | 7.49% | 6.72% |
| TEST | 1,000 | 5 | -0.58% | -0.05% | -3.50% | 9.24% | 7.19% |
| TEST | 100,000 | 5 | -0.71% | -0.19% | -4.64% | 10.51% | 8.74% |

Moving a 30-day window's start by one 10-minute sample moved its return by up to 0.5 pp at 100,000 (calm-2026-04: 2.89% to
2.37%). A difference smaller than that between two variants on one window is noise; LC-L1's start offsets apply to every window.

A variant: `bun packages/backtest/cli/sweep.ts --policy conservador-lab-guards-v1 --set guards.byBucket.risk.fallFreeze.fallBps=500 --name risk5`
(TRAIN, deposits 1,000 and 100,000, the unchanged policy as baseline beside it; `--split test` to judge it).

## Tasks (next sessions)

| Id | What | Accepts |
|---|---|---|
| LC-T1 | Fix #5 (manage-any on all three pools). Hard prerequisite for any volatile-bucket exit. | #5 acceptance |
| LC-T2 | Datasets: export D1 `pool_snapshots` to `mamoru-dataset-v1`; add pool balances and oracle reads to `backfill.ts`; mainnet overlay loader for LC-L4 | dataset ids in the Lab note |
| LC-T3 | `packages/decide/src/guard/` Risk Monitor, pure, with `policy.guards` and `Observation.guard`; reason codes; `Decision.guards` | decide unit tests per rule; FR-LC-001 byte-identity test |
| LC-T4 | Exit legs (`close_position` with cause, `exit_convert`), precedence, EHG override rules | LC-L2, LC-L6, LC-L8 |
| LC-T5 | Simulator: `observe()` fills `guard`, new metrics; `conservador-lab-guards-v1`; LC-L1..L9 sweep with walk-forward | Lab note with the table above filled |
| LC-T6 | Engine: build `Observation.guard` (journal cost basis, #129 ledger, snapshot loop history, oracle reads), persist bucket state in the DO | fork e2e |
| LC-T7 | `conservador-live-v3` with `guards.mode = 'shadow'`; two weeks of would-be codes on live | `/ops` shows them |
| LC-T8 | App: bucket state lines, history with trigger and threshold, risk page copy (#58) | UI scenario per state |
| LC-T9 | `guards.mode = 'enforce'` after Ot's GO on the Lab table and the shadow log, and only once D5 is resolved | Ot GO |

## Packaging shadow rules (phase 1, otto/mamoru#101)

Source: Brais's Packaging document (pool monitor sections A and C, entry gate). Shadow only: every row writes to
`Decision.shadowRisk`, outside the premise hash (`premiseHash` and `decisionId` never move with any value here), and the
engine logs `[shadow]` when the set of firing rules changes. Gate: the policy lists `packaging:tvl`. No policy object
changes, so no `policyHash` changes. Nothing acts: a row says what would have exited.

| Rule | Condition (would EXIT) | Code | `window` |
|---|---|---|---|
| PR1 floor | pool TVL (on-chain, token balances at TWAP) under 2,000,000 USDC | `RISK_POOL_TVL_FLOOR` | none |
| A. TVL change | TVL now vs 1 day ago at or under -12% | `RISK_POOL_TVL_DROP` | `1d` |
| A. TVL change | vs 7 days ago at or under -20% | `RISK_POOL_TVL_DROP` | `7d` |
| A. TVL change | vs 30 days ago at or under -30% | `RISK_POOL_TVL_DROP` | `30d` |
| B. Activity | `Volume7d` under `max(TVL * ratio, floor)` by bucket: stables 0.35x / 1,000,000, btc-usdc 0.25x / 300,000, risk 0.05x / 20,000 (USD) | `RISK_POOL_VOLUME_LOW` | `7d` |
| B. Activity, stables only | volume of the last full day under 30% of the 28 day daily average | `RISK_POOL_VOLUME_LOW` | `28d` |
| C. Unreadable | a figure a rule needs is missing, stale or not a number; the rules that can be computed still are | `RISK_POOL_STATS_UNREAD` | none |
| PR1 unreadable | on-chain pool balance not readable | `RISK_POOL_TVL_UNREAD` | none |

Units in an entry: `RISK_POOL_TVL_DROP` carries basis points (`threshold` -1200, `metric` the measured change);
`RISK_POOL_VOLUME_LOW` carries raw savings units (USDC, 6 decimals).

Data (operator, not `decide`): DefiLlama `yields.llama.fi/chart/<id>` for the TVL 1d/7d/30d ago, GeckoTerminal
`/pools/<address>` (`reserve_in_usd`, current TVL) and `/pools/<address>/ohlcv/day?limit=29` (complete days only; the day
in progress is dropped) for the volumes. Refreshed at most hourly per pool, no API keys; a failed fetch keeps the last good
value for 6 h, then the fields are null and the rule reports `RISK_POOL_STATS_UNREAD`. Reaches `decide` as
`Observation.poolStats`, read only by the shadow rule.

## Decisions for Ot

- **D1.** Account loss limit default: 10% of net deposits, owner resumes by hand. Or user-chosen at Start (#56).
- **D2.** USDC depeg: freeze everything and wait (proposed; March 2023 recovered in 3 days), or rotate to USDT through
  the stables `enter-swap` grant.
- **D3.** Exit target: idle USDC in the Safe (proposed, no new grants), or lending (new grants, #55).
- **D4.** A parked bucket's share waits in USDC (proposed) or is redistributed to the other buckets.
- **D5.** Constitution VI keeps Packaging numbers (`packaging:depeg`, `packaging:tvl`, `packaging:price-impact`) in
  shadow until T-000056 (#56). `enforce` (LC-T9) is blocked until #56 closes with the Lab table or the constitution is
  amended. Proposed path: shadow on live first (LC-T7), then amend VI with the Lab evidence.
- **D6.** Constitution V amendment for the convert leg: bounded at 500 ticks of TWAP deviation (proposed), or literal
  V (swap at any price when the session is valid), or the 100 ticks of every other operation (exits later in a crash).
- **D7.** Oracle: Chainlink feeds on Base as a new read-only registry dependency (proposed), or pool-only rules
  (no depeg direction, no divergence rule).

Provisional defaults for the Packaging rules (Ot, 27 Oct; discussion open with Brais). Shadow only until D5 resolves.

- **D8.** Stale or missing data: FREEZE the bucket and alert, never exit on missing data (keeps FR-LC-007). Shadow today:
  `RISK_POOL_STATS_UNREAD` and `RISK_POOL_TVL_UNREAD`.
- **D9.** IL / rally exit (Packaging's price rules): shadow only.
- **D10.** ENY / APY exit: only once ENY leaves shadow.
- **D11.** Safety Score: dropped. Covered by incidents plus the Purga re-run.
