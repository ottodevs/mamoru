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

Phase 4 (shadow only): `RISK_VAULT_SHARE_DIP`, `RISK_VAULT_SHARE_LOSS`, `RISK_VAULT_TVL_DROP`,
`RISK_VAULT_EXIT_LIQUIDITY`, `RISK_VAULT_POSITION_RATIO`, `RISK_VAULT_PAUSED`, `RISK_VAULT_FROZEN`, `RISK_VAULT_UNREAD`, `RISK_VAULT_BOOTSTRAP` (a re-validation label only).

Phase 3 (shadow only): `RISK_RERANGE_BUDGET_SPENT`, `RISK_ACTION_BUDGET_SPENT`, `RISK_ACTION_BUDGET_UNREAD`, `REENTRY_COOLDOWN_SHADOW`,
`REENTRY_REVALIDATION_SHADOW`, `RISK_PURGA_RECHECK_FAILED`, `RISK_PURGA_RECHECK_UNREAD`.

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
| LC-T10 | Phase 3 shadow rows (section above): `Observation.rotation` filled by the operator; `includedAt` on every counted op kind; `GET /internal/engine-ops/<safe>` on both operators and `actionBudgetShadowRisk` after `decide` (after the send) over the union (`RISK_ACTION_BUDGET_UNREAD` when a configured peer cannot be read); the re-range row while `maxPerWeek` is unset or above 2; the per-account shadow files `shadow-vaults/rotation/<account>.json` (attempts) and `purga.json`; `purga-reviews.json` for every policy pool of both registries and both v7 vaults and the Purga row with its alert; cooldown and re-validation wired to the `left` records once LC-T4 lands | decide unit tests per code; `actionBudgetShadowRisk` tests: 5 counted ops hold the 6th; an entry, an idle convert, an exit leg and an owner withdrawal do not count; a reduce and a ratio convert do; an op in flight counts and a failed one is dropped; a re-range dated by `rerangeAt` counts; a configured peer that answers 401 gives the unread row, a peer answering the empty body for a Safe it does not run is a clean read, a body without `ops` is unread, no peer counts the local list; a held proposal is not an attempt; a replayed review writes no second attempt; two accounts attempting the same pool in one block both get their attempt; a pool held with `purgaReviewedAt` 91 days old gives the row on every review, no exit, and the Purga step posts once at the start and once more 7 days later, never per account; identity missing with a fresh date gives the unread row and the step marks nothing, an account review with identity missing and a 91-day date gives both the unread and the failed row, and the step still starts `failingSince` and posts; a start post that failed is posted after the pool passes again; the step and sender run on the Monad operator; an entry into a failing pool the account never held carries the row; re-validation with an unreadable identity or a `left` code without an evaluator does not pass and names it; `premiseHash`, `decisionId`, bucket state and proposal unchanged with every row present; a throwing shadow write and a peer that hangs leave the send on time; a phase 3 throw inside `decide` gives the decision without `rotation`; an unparsable date in `purga-reviews.json` fails that pool by date and shows in `/ops`; on a first run the first Purga alert is posted, also when the first post fails, nothing was due at the first step, or the process dies between the first step and the first post |
| LC-T11 | Lab: replay `base-2025-10-crash-10m`, `base-2025-02-crash-10m` and `sep2026` with the phase 3 rows (`rotation` from the simulator's own run, no peer); `range.maxPerWeek` = 2 against no cap (an engineering setting, so the Lab may enforce it), and the would-be `RISK_ACTION_BUDGET_SPENT` codes in shadow, reported as an upper bound (held ops are still sent and counted); drawdown, gas and return per window | Lab note |
| LC-T12 | Monad: a data source for WMON/USDC (GeckoTerminal now lists it on network `monad`; PR #205 reads it on the Monad operator, own TVL series for the lookbacks), then datasets and the oracle choice; the phase 1 and 2 rows on the Monad operator | dataset id; phase 1-2 rows readable on Monad |
| LC-T13 | Incident exits: a producer for `RISK_INCIDENT_EXIT` (spec 001) from pool pause, oracle pause, bridge or admin change, upgrade and exploit feeds (Packaging section F), plus the manual `IncidentFlag`. Shadow first like every Packaging row (gate `packaging:incident`); acting needs D5 resolved and Ot's GO on its shadow log | own ticket |
| LC-T14 | Phase 4 vault rows in shadow on the v7 Stable vaults: hourly vault reads in the Base operator (share value at `10^vault.decimals()`, the TVL measures, payable liquidity, waBasUSDC deficit and pause state); the phase 4 shadow store `shadow-vaults/` with one file and one writer per part (`vaults.json` from `vaultShadowStep` once per read: series, payable liquidity, `mark`, `deficitBase`, `indexAtBase`, episode fields, `bootstrappedAt`, `rebasedAt`, `appliedRebaseId` per vault, `alertsDue` (no stored entry block: it is derived from the firing rows); `accounts/<account>.json` from each review: `exitShortSince` per vault; `alerts.json` from the sender; these by atomic rename; `rebase.jsonl` appended by the `/ops/vault-rebase` route under its mutex inside the phase 4 lock), outside bucket state and the premise hash; the D14 internal alert on an episode opening or a latch, live operator only (`alertsDue` in the vault part, `alerts.json` written by the sender after each post); the `/ops` re-base action; `/ops` marks the exempt pool rows of a `stables-lp` position as informational, never depeg, incident or vault rows (D12) | decide unit tests per code: a share value 2 bp under (dip), still 2 bp under 5 days later (same episode, no loss), 0.5 bp under (episode still open, dip row still active), deepening to 12 bp (loss, latched), a second 2 bp episode opened 20 days after the first one opened and closed (loss); a waBasUSDC deficit rising by 2 bp of supply (dip), then closing once the reserve's interest since the base passes 2 bp, and again when the deficit is covered; re-base clears the latch and `lastDipOpenedAt` (a dip 12 days after an accepted one is a first episode), waits on an unread step, and is rejected when the fresh read is more than 1 bp under its accepted baseline (a re-base followed by a 40 bp loss latches and alerts); two accounts in one hour produce one alert; exit liquidity short for 5 h does not fire, 6 h does; an unread read changes no state; an entry block on gtUSDCp leaves waBasUSDC open; a frozen reserve gives `RISK_VAULT_FROZEN` (deposit block) and no `RISK_VAULT_PAUSED`; a TVL window not yet covered emits nothing; a D12 test where a `stables-lp` position proposes nothing on its pool rows while a depeg still freezes; operator tests: an `/ops` re-base appended while a step runs is applied by the next step; two re-bases at once get two ids; a re-base of gtUSDCp applies while waBasUSDC is unread and the waBasUSDC one waits; a torn last line is ignored without a reset; a crash mid-append followed by an append leaves the earlier complete request and the new one readable; a complete line without its newline is not applied, and no applied id is ever reused; with the log lost and `vaults.json` intact the next re-base gets an id above every counter and is applied; a second instance on the same state directory starts without phase 4, writes no phase 4 file and says so, and takes over at its next step after the holder is killed; a `vaults.json` of the wrong shape for its version leaves the live decision and `premiseHash` unchanged, is not rewritten, and shows a store error; a `vaults.json` written by the previous version is migrated with its latch intact; one of a newer version (rollback) is left untouched; a replayed re-base (same nonce) is refused, a signed request with a changed body is refused, and the route refuses on a non-holder and while `vaults.json` is contained; an `alerts.json` of a newer version is neither rebuilt nor posted from; a contained account file skips only that account; the takeover test runs with a child process spawned by the holder (the lock fd is `O_CLOEXEC`); after a reset old requests are not re-processed; a failed post is retried next hour; a crash between post and record re-posts once; a fork read of both vaults confirming the 2 Nov facts (MetaMorpho v1.0 without `lostAssets`, Pool revision 11 getters, static aToken `paused()` and its `maxWithdraw` against the virtual balance); `premiseHash` unchanged with the store present; a v7 holder with both vault dates fresh gets no Purga row; an operator test where one instance running v7 computes both phase 3 and phase 4 rows on one lock handle; vault re-validation tests: an uncovered TVL window gives `RISK_VAULT_TVL_DROP:<window>`, a `left` record older than the bootstrap gives `RISK_VAULT_BOOTSTRAP` until an applied re-base, a rejected re-base does not lift it; a re-entry of 1,000 USDC into a recovered vault the account holds 0 shares of passes exit liquidity (payable liquidity, not `maxWithdraw`); USDC transferred straight to the MetaMorpho contract while its markets are illiquid adds nothing to payable liquidity; a frozen reserve read before a restart still gives `RISK_VAULT_FROZEN` in the first review after it (the latest read is persisted in `vaultShadow`); a failed first read leaves the vault unbootstrapped and unread, and the next ok read bootstraps it; a persisted ok read 3 h old gives `RISK_VAULT_UNREAD`; a persisted read 3 h old is also an unreadable identity for the Purga step (`RISK_PURGA_RECHECK_UNREAD`, no alert, `failingSince` unchanged) unless the date is over 90 days |

## Packaging shadow rules (phase 1, otto/mamoru#101)

Source: Brais's Packaging document (pool monitor sections A and C, entry gate). Shadow only: every row writes to
`Decision.shadowRisk`, outside the premise hash (`premiseHash` and `decisionId` never move with any value here), and the
engine logs `[shadow]` when the set of firing rules changes. Gate: the policy lists `packaging:tvl`. No policy object
changes, so no `policyHash` changes. Nothing acts: a row says what would have exited.

| Rule | Condition (would EXIT) | Code | `window` |
|---|---|---|---|
| A. TVL change | TVL now vs 1 day ago at or under -12% | `RISK_POOL_TVL_DROP` | `1d` |
| A. TVL change | vs 7 days ago at or under -20% | `RISK_POOL_TVL_DROP` | `7d` |
| A. TVL change | vs 30 days ago at or under -30% | `RISK_POOL_TVL_DROP` | `30d` |
| B. Activity | `Volume7d` under `max(TVL * ratio, floor)` by bucket: stables 0.35x / 1,000,000, btc-usdc 0.25x / 300,000, risk 0.05x / 20,000 (USD) | `RISK_POOL_VOLUME_LOW` | `7d` |
| B. Activity, stables only | volume of the last full day under 30% of the 28 day daily average | `RISK_POOL_VOLUME_LOW` | `28d` |
| C. Unreadable | a figure a rule needs is missing, stale or not a number; the rules that can be computed still are | `RISK_POOL_STATS_UNREAD` | none |
| B. EEL (gate `packaging:eel`) | EEL under the bucket minimum (USD): stables 600,000, btc-usdc 350,000, risk 75,000. EEL = largest sell size whose price impact is within the bucket limit: stables 200 bps, btc-usdc 200, risk 500 | `RISK_POOL_EEL_LOW` | none |
| E. Exit slippage | quoted slippage (impact at the combined size of the account's non-USDC legs in the pool, which a full exit sells, plus the pool fee) at or over: stables 300 bps, btc-usdc 300, risk 600 | `RISK_EXIT_SLIPPAGE` | none |
| E. Position ratio | account value in the pool (both legs) over EEL above: stables 1000 bps, btc-usdc 1000, risk 500 | `RISK_POSITION_RATIO` | none |
| Depth unreadable | no curve, an all-null or malformed one, older than 6 h, or an exit size past the last ladder point with every quote good ("beyond ladder"); the callback present but failing gives an empty object, so every USDC pool is unread (no callback, as on Monad, stays silent, #171) | `RISK_POOL_DEPTH_UNREAD` | none |

No TVL floor (D15, Brais 2 Nov: the Packaging's 2M entry minimum is dropped for a pool Mamoru itself chose and
recommends). Every policy pool is one, so the PR1 floor row and its unreadable row are gone, and the engine no longer
reads the pools' token balances for them. The codes `RISK_POOL_TVL_FLOOR` and `RISK_POOL_TVL_UNREAD` stay in the domain
list for the shadow logs already written; a pool Mamoru did not choose (none today) would bring the floor back. The TVL
change rows, the activity rows and the EEL minimums are unchanged.

Units in an entry: `RISK_POOL_TVL_DROP` carries basis points (`threshold` -1200, `metric` the measured change);
`RISK_POOL_VOLUME_LOW` carries raw savings units (USDC, 6 decimals). `RISK_POOL_EEL_LOW` carries raw savings units
(`threshold` the bucket minimum, `metric` the EEL); `RISK_EXIT_SLIPPAGE` and `RISK_POSITION_RATIO` carry basis points
(no `metric` on a size past the ladder). Bucket mapping of Brais's names: stables = Stables, btc-usdc = Bluechip, risk =
Mercenary. Only pools that pair USDC, only USDC-savings policies.

Data (operator, not `decide`): GeckoTerminal `/pools/<address>` (`reserve_in_usd`, current TVL) and
`/pools/<address>/ohlcv/day?limit=29` (complete days only; the day in progress is dropped; a missing day inside a window
makes that window unread, never zero volume) for the volumes. TVL 1d/7d/30d ago comes from the operator's own hourly
samples of that current TVL, kept 31 days in `stateDir/pool-stats.json`; until that series is long enough, DefiLlama
`yields.llama.fi/chart/<id>` fills in. DefiLlama's yield endpoints need a paid plan from 2026-11-13, so after that date
the 30d rule is unread until the own series reaches 30 days. Refreshed at most hourly per pool, no API keys; each source
keeps its last good value for 6 h, then its fields are null and the rule reports `RISK_POOL_STATS_UNREAD`. Reaches `decide` as
`Observation.poolStats`, read only by the shadow rule.

Depth data (operator): per live pool that pairs USDC, the price impact of selling the pool's non-USDC token for USDC (the
exit direction) at 1k, 3k, 10k, 30k, 100k, 300k, 1M, 3M and 10M USD. Each size is converted to the sell token at the pool's
slot0 mid price and quoted with QuoterV2 `quoteExactInputSingle` (eth_call at one block); `impactBps = round((1 - out /
(in at mid x (1 - fee))) x 10,000)`, at least 0, so the pool fee is not in it (the exit slippage rule adds it). QuoterV2 never
reverts on a size too large (it answers the partial fill, read as a high impact); a zero output is null (nothing to sell
into), and the ladder stops there. Such a null after good points is
treated as a point of 10,000 bps, and EEL and exit slippage interpolate linearly in size over the same curve (impact 0 at
size 0), also above the null point; all nine within the limit gives 10M (">=10M"). The exit size is the USD value of the non-USDC legs of all the account's positions in the pool at slot0, summed; the ratio
uses their whole value (principal, no uncollected fees). Refreshed hourly in the background (one block read, then one slot0 and at most nine quotes per pool, in
sequence, each with a timeout; the keyed RPC budget is asked before every call, and when it trips that pool's read ends and its old curve stays), kept in memory only, null after 6 h. A failed quote is not depth by its error text (an RPC failure can come wrapped as a revert): the
pool's in-range liquidity is read, and 0 (drained) makes that size null; anything else leaves the
curve not overwritten and the pool is retried after 5 min. Base operator only; Monad pools
are not read. Reaches `decide` as `Observation.poolDepth`, read only by the shadow rules.

## Packaging shadow rules (phase 3: rotation and re-entry, otto/mamoru#101)

Source: Packaging §5.3 (global rotation limit, per-bucket cooldowns, re-entry). Same contract as phases 1 and 2: shadow
only, every row writes to `Decision.shadowRisk` outside the premise hash, nothing acts (constitution VI), and no
acceptance row depends on a Packaging number changing behaviour. Gate: the policy lists `packaging:rotation` in
`policy.shadow` (the same switch as `packaging:tvl`, not `guards.mode`, so LC-T9 flipping `guards.mode` to `enforce`
leaves these rows in shadow).

The Packaging caps activity: at most 2 rebalances per week, at most 5 portfolio actions per month (exits not counted),
at most 1 re-entry attempt per pool per cooldown. On the October 2025 replay the live policy made 12 re-ranges in one
week, each one selling the fall ("Measured exposure"): a re-range budget is the cheapest form of "do not chase".

| Rule | Condition (would hold the proposal) | Code | `window` |
|---|---|---|---|
| Action budget | the decision proposes a countable op (below) and the account already has 5 counted ops in the 30 days before the review's block timestamp. `pool`: the proposal's pool | `RISK_ACTION_BUDGET_SPENT` | `30d` |
| Action budget unread | a peer operator is configured and its list could not be read (below) | `RISK_ACTION_BUDGET_UNREAD` | `30d` |
| Re-range budget, cap unset | a re-range is proposed, `range.maxPerWeek` is absent or above 2, and the pool already has 2 re-ranges in the rolling 7 days before the review (`recentReranges`, the same list and window as #218's `DECIDE_RANGE_WEEKLY_CAP`, merges excluded) | `RISK_RERANGE_BUDGET_SPENT` | `7d` |
| Cooldown | an entry is proposed into a pool the bucket left on a rule, less than the cooldown after it left (stables 7 d, btc-usdc 4 d, risk 10 d), or less than the cooldown after the previous attempt into that pool | `REENTRY_COOLDOWN_SHADOW` | none |
| Re-validation | not in cooldown, an entry is proposed into a pool the bucket left on a rule, and at least one check of the closed set below does not pass. `label`: the codes that do not pass, sorted, comma separated | `REENTRY_REVALIDATION_SHADOW` | none |
| Purga while invested (D11) | the pool fails Purga: `purgaIdentity` gives `NO_GO`, or its `purgaReviewedAt` in the registry is absent or more than 90 days before the review. Fires for a pool the account holds a position in, and for any entry or increase proposed into a failing pool, held or not | `RISK_PURGA_RECHECK_FAILED` | none |

### Inputs and where each rule runs

`decide` stays pure. Phase 3 reads one new shadow-only field, `Observation.rotation`, supplied by the operator for a
policy that lists `packaging:rotation`, never hashed (same rule as `poolStats` and `poolDepth`: the premise body never
sees it, so nothing in it can move `premiseHash` or `decisionId`):

```ts
rotation?: {
  ops: { chain: number; opId: string; kind: 'rerange' | 'reduce' | 'ratio-convert'; at: bigint }[] // this chain, counted ops, 30 days
  left: { bucket: string; pool: string; at: bigint; code: string }[] // pools a bucket left on a rule (LC-T4), with the exit's inclusion time
  attempts: { pool: string; at: bigint }[] // re-entry attempts, 30 days
  purgaReviewedAt: Record<string, string> // pool name -> ISO date of its last Purga review
}
```

- Re-range budget, cooldown, re-validation and Purga while invested are computed inside `decide` from the observation.
- The action budget is computed after `decide`, by a pure function `actionBudgetShadowRisk(decision, rotation, peerOps)`
  that the engine calls only when the decision proposes a countable op, after the proposal has gone to the send path
  (never before it: the send does not wait for the peer read), and whose rows the engine logs as a follow-up shadow
  record keyed by the `decisionId`. The peer list is read only for those reviews (below), so a review
  that proposes nothing countable makes no peer call, and `decide` never does I/O.
- Lab and backtest: the simulator fills `rotation` from its own run (its journal of ops and exits) and has no peer, so
  `peerOps` is the empty list of a successful read. With no peer configured the local list is the account's whole
  history: correct for a single-chain account, and the reason the unread row exists only where a peer is configured.

### Counting the action budget

- Counted ops (D16): the engine's rebalancing decisions only: `rerange`, reduce and ratio convert. An entry or idle
  convert never counts: it places money the owner deposited (the Packaging's BOP exception) or re-enters a pool, and
  re-entry has its own cooldown and re-validation rows. Exit legs (`close_position` or a vault withdrawal with an exit
  cause, `exit_convert`), harvests, bridge legs and owner withdrawals (an exit leg with the owner as its cause) never
  count. A vault withdrawal without an exit cause is a reduce and counts. The two converts differ by what they move:
  an idle convert places idle USDC (a deposit, harvest proceeds, an exit's USDC) toward its bucket's target and never
  counts; a ratio convert swaps value already placed between assets to restore a target ratio and counts. A deposit
  arrives as idle USDC, so it is only ever placed by an entry or an idle convert: a depositor never spends the budget
  by depositing, on either chain, and no deposit has to be tracked.
- Where counted ops live: `includedAt` is a field of the stored engine op in the operator's journal, like `rerangeAt`
  today; the premise never hashes the journal.
- An op counts from the moment it is sent, dated by the review's block timestamp, until it is confirmed (then dated by
  its inclusion: `includedAt`, added by LC-T10 to every counted kind; a re-range stored before the field uses its
  `rerangeAt`) or fails, is refused or is pre-empted (then it is dropped). Counting the op in flight is what keeps two
  quick proposals, or one on each chain, from both seeing 4.
- The rest of the residual: two operators sending an op in the same 2 s, each before the other's list shows it, can
  reach 6. The same bound as the exposure cap of #212, accepted there.
- A row stored before LC-T10 with neither `includedAt` nor `rerangeAt` is skipped: the budget under-counts for at most
  30 days after the field ships, never over-counts.
- Reading the shadow log: in shadow the ops the budget would have held are still sent, and they count, so after a
  first hold the log can show more `RISK_ACTION_BUDGET_SPENT` rows than enforce would. LC-T11 reports the same rows as
  an upper bound; a faithful count of what enforce would hold needs a Lab variant that enforces the budget, which
  constitution VI does not allow for a Packaging number until #56, so it is out of scope here.

Across chains (the Packaging counts the portfolio): each operator answers `GET /internal/engine-ops/<safe>?since=<unix>`
with one body, `{ ops: { chain, opId, kind, at }[] }`: its counted ops for that Safe with `at` at or after `since`.
The empty answer is `{ "ops": [] }`; a body without `ops` is malformed. Same address on every chain (the CREATE2 Safe
of #212), same authentication as `/internal/exposure`: an operator-to-operator read signed like `GET /metrics` with the
shared `OPERATOR_SECRET` (`metricsSignature` over method, path and the unix minute; the path carries the Safe, the
`since` query is not signed: a replay inside the minute reads the same Safe, as with #212), never an owner signature. The engine reads it through
the same reader as #212's `PeerExposure`: at most 2 s old, 5 s timeout. It counts the union of both lists,
deduplicated by `chain` + `opId`. A Safe the peer runs nothing for, or has no counted ops for, is `200` with the empty body, a
successful empty read (most accounts have no Monad sleeve). Unread is only: unreachable, 401, a 404 for the route
itself (a peer on older code), 5xx, timeout or a malformed body. Those give `RISK_ACTION_BUDGET_UNREAD`, never a
local-only count reported as the account's.

### Re-entry

- A pool "left on a rule" is a `left` record: written by the exit path (LC-T4) when a bucket's exit leg confirms, with
  that leg's inclusion time and the rule's code. Before LC-T4 no bucket leaves a pool on a rule, so the cooldown and
  re-validation rows have nothing to read and stay silent. A record is dropped once its bucket re-enters the pool.
- An attempt is a decision that proposes an entry into a pool or vault with a `left` record and that no row holding the
  proposal held: any phase 3 or phase 4 row that would hold it (cooldown, re-validation, Purga, and on a vault the dip,
  latch, paused, frozen and unread rows) or the depeg freeze. An entry is never countable (D16) and a decision carries
  one proposal, so the budget rows never apply to it; the attempt is written right after the decision is logged: the
  op an enforcing engine would have sent. A held proposal is not an attempt, so in enforce mode a
  held proposal never restarts its own cooldown. The engine writes `{ pool, at }` with the review's
  block timestamp after it logs the decision, in that account's file; the same `(account, pool, at)` is never written
  twice, so a restart or a replayed review adds nothing, and two accounts attempting the same pool in one block are
  both recorded.
- The closed set for re-validation, on the pool being entered:
  - the phase 1 and 2 rows that would exit (`RISK_POOL_TVL_DROP`, `RISK_POOL_VOLUME_LOW`, `RISK_POOL_EEL_LOW`,
    `RISK_EXIT_SLIPPAGE`, `RISK_POSITION_RATIO`), on every pool including USDC/USDT: D12 lets a held `stables-lp`
    position stay, it never lets new money back in;
  - their unread rows (`RISK_POOL_STATS_UNREAD`, `RISK_POOL_DEPTH_UNREAD`): missing data does not pass (D8);
  - `purgaIdentity` and the pool's `purgaReviewedAt`, as in the Purga row; here an unreadable identity
    (`RISK_PURGA_RECHECK_UNREAD`) does not pass either (D8);
  - the condition of the `left` record's own code, evaluated on this observation. A code with no evaluator on a single
    observation (`EXIT_LOSS_CONTROL`, account-level and history-dependent, or any code phase 3 does not know) does not
    pass and is listed by its own code: such a pool comes back only through the owner or a later rule change.

  `RISK_EXIT_SLIPPAGE` and `RISK_POSITION_RATIO` on a pool the account holds nothing in are evaluated at the proposed
  entry's size (the non-USDC leg it would buy, and that size over EEL), the size a later full exit would sell.

  On a vault (phase 4) the pool rows above are absent and the set is instead: every phase 4 vault row
  (`RISK_VAULT_SHARE_DIP`, `RISK_VAULT_SHARE_LOSS` while latched, `RISK_VAULT_TVL_DROP`, `RISK_VAULT_EXIT_LIQUIDITY`,
  `RISK_VAULT_POSITION_RATIO`, `RISK_VAULT_PAUSED`, `RISK_VAULT_FROZEN`, `RISK_VAULT_UNREAD`) must not fire, exit
  liquidity and position ratio evaluated at the proposed entry's size added to the holding, instantly (the 6 h hold is
  for a held position, not for a check before entering), and against the vault's payable liquidity only: `maxWithdraw`
  is capped by what the account already holds (ERC-4626), so it never counts money not yet deposited; the vault's Purga as in the
  Purga section; and the `left` code, a `RISK_VAULT_*` code being evaluated by its own row. So a vault left on
  `RISK_VAULT_SHARE_LOSS` passes only once re-based (`lossLatchedAt` null), and one left on a TVL drop passes once the
  drop no longer holds. Missing data does not pass here either (D8): a TVL window the series does not cover yet, an
  unreadable identity, and a `left` record older than the vault's last bootstrap (`bootstrappedAt` in `vaults.json`: a
  lost store forgets the latch, so such a record passes only while the vault's `rebasedAt` is set, the time of a re-base
  applied after that bootstrap; a rejected request never sets it). In the `label` these appear as
  `RISK_VAULT_TVL_DROP:<window>` for an uncovered window and `RISK_VAULT_BOOTSTRAP` for a record older than the
  bootstrap.

  It never includes phase 3 rows (no circularity) or the account-level action budget. A pool whose phase 1 and 2 rows do
  not run (no stats source) passes those two items as absent, not as failed. Once LC-T12 (PR #205) merges every policy pool
  has one, and before LC-T4 no `left` record exists, so the case does not arise on live.
- Cooldown and re-validation are checked in that order. A proposal in cooldown gets only the cooldown row.

### Purga while invested (D11)

- Runs on every review of both operators, for every pool the account holds a position in. It needs no I/O:
  `purgaIdentity` reads the observation's pool identity against the registry, and `purgaReviewedAt` is the ISO date of
  the last Purga review by Ot or Brais, per pool, kept in `packages/registry/purga-reviews.json` beside the registry,
  not in its entries (so writing a date never moves a registry, policy or premise hash). The operator passes the dates
  in as `rotation.purgaReviewedAt`; LC-T10 fills the file for every policy pool and both v7 vaults from the review notes.
- A vault is in scope like a pool. Its identity check is the vault's own: code at the registry address and `asset()`
  equal to the registry's USDC, both in the hourly vault reads (Data, phase 4). A failed read is
  `RISK_PURGA_RECHECK_UNREAD` here and `RISK_VAULT_UNREAD` in phase 4; it does not pass re-validation. Re-checking the identity catches a registry or pool change; the date catches the slow criteria (audits, age,
  team, DeFiSafety, L2Beat) that no code reads: a pool nobody has re-reviewed in 90 days fails.
- An identity that cannot be checked (`PURGA_IDENTITY_INCOMPLETE`, the observation lacks the pool's identity) is
  `RISK_PURGA_RECHECK_UNREAD`, not a failure, and sends no alert.
- Would-be action: no new money into a failing pool. Every entry or increase proposed into it carries the row, whether
  the account holds a position there or not, so the shadow log and the Lab count every deposit it would have held. Never an exit by itself: an exit comes from
  an incident (LC-T13) or another rule. Today, with LC-T13 in shadow too, a pool failing Purga has no exit path, and that
  is the intended default.
- Real, also in shadow: an internal alert per pool, never per account. The Purga step (State, below) posts one line to
  `ops-mamoru` and shows an `/ops` row (pool, failed check, time) when a policy pool or vault starts failing, then one
  every 7 days while it keeps failing, whether or not an account holds it. The owner sees nothing. The account review's
  row is unchanged (it reads its own observation); only the alert moved out of it.

### State

Everything phase 3 remembers per account (`attempts`) lives in the operator's shadow store
(`shadow-vaults/rotation/<account>.json`, one file per account (Safe), written only by that account's review, never
shared between accounts),
never in the bucket state and never in the premise. `left` comes from the
bucket state LC-T4 writes, read only. "No state or proposal change with the rows present" (LC-T10) refers to the bucket
state, the premise and the proposal; the shadow store is the rows' own memory.

Purga step: a pure function in `decide`, `purgaShadowStep(store, checks, reviewedAt, now, sentAlertIds) -> store`, run once an hour
on every operator whose policy lists `packaging:rotation`, before the account reviews of that hour, over every policy
pool and vault of that operator (`checks`: the identity of each, read once for the step). Its file,
`shadow-vaults/purga.json`, has it as the only writer: per pool `failingSince` (null while it passes) and `alertsDue`,
with ids `<pool>:purga:<failingSince>:<n>`, `n` the whole 7-day periods since `failingSince` (0 at the start).
The date half needs no read and is always evaluated: a pool with `purgaReviewedAt` absent or older than 90 days fails
whatever its identity read. An unreadable identity only stops the identity half from starting or clearing
`failingSince`; an identity read more than 2 h before the step is unreadable too, the same staleness rule as the
review's. `alertsDue` drops an id only once it is in `alerts.json` (the `sentAlertIds` input, the vault step's
rule), so a start alert whose post failed is still posted after the pool passes again. The alert sender posts them
like phase 4's.

Containment: every phase 3 failure (building `Observation.rotation`, loading `purga-reviews.json`, the four rows
inside `decide`, an attempt write, the budget step, the peer read, the Purga step) is caught at operator
level, shown in `/ops`, and leaves the live decision and its send untouched: a throw inside `decide` from phase 3
re-runs `decide` without `rotation`. `purga-reviews.json` is validated on load; an entry whose date does not parse as
an ISO date is treated as absent for that pool (so it fails Purga by date) and `/ops` names it; an attempt that cannot
be written goes unrecorded (a cooldown may be missed, shadow only). LC-T10 tests a throwing shadow write and a peer
that hangs: the send happens on time in both.

One writer: the `rotation/` files sit in `shadow-vaults/` with the phase 4 files and follows phase 4's single-holder
rule (below): only the instance holding that directory's lock writes it, reloading it from disk when it takes the lock.
The process has one lock handle for `shadow-vaults/`, shared by the phase 3 step, the vault step and the re-base
route: whichever runs first tries that one handle (at start and at every step, without blocking), and once acquired it
is held for the life of the process and serves all three. On acquisition the process reloads every file in the
directory, the `rotation/` files included. This runs on every operator and for any policy that lists
`packaging:rotation`, whether or not it lists `packaging:vaults`: the Monad operator, and a Base policy without
vaults, have a `shadow-vaults/` holding only the `rotation/` files, `purga.json` and `alerts.json`. A missing or unparsable account file starts empty and `/ops`
shows it once with its time (its attempts are forgotten, so a cooldown since an attempt may be missed for that
account; the budget itself reads the journal and is unaffected);
the file is written whole and renamed and carries a schema `version`, with the same migration and contained-error rules.
An instance without the lock computes no phase 3 rows for that step (shown in `/ops`), so two instances during an
overlapping deploy never both rewrite the attempts or the alert files.

### Notes

- **Re-range budget: already built.** The Packaging's "2 rebalances per week" is the weekly re-range cap of #218
  (`range.maxPerWeek` in the engine settings, per pool, enforced, `DECIDE_RANGE_WEEKLY_CAP`, rolling 7 days). It is an
  engineering setting set from `/ops`; the Packaging value for it is 2. The row above reports what a cap of 2 would have
  held while `/ops` leaves it unset or above 2, and goes silent once it is set to 2 or less.
- After the stables bucket moves to an ERC-4626 vault (#210, PR #174) it has no range and makes no re-range; its
  deposits never count in the action budget (entries) and its withdrawals count as reduces unless they carry an exit
  cause or pay the owner (as above).
- Monad: the counters and the Purga row need no outside source and run on both operators. The phase 1 and 2 pool rows
  run on the Monad operator from LC-T12 (PR #205).

## Packaging shadow rules (phase 4: the Stable bucket in ERC-4626 vaults, otto/mamoru#101)

Context: `conservador-live-v7` (#210, PR #174) puts the Stable bucket in two USDC vaults on Base, `vault:gtUSDCp`
(MetaMorpho) and `vault:waBasUSDC` (Aave static aToken), and keeps the USDC/USDT position as `stables-lp`, held until
the owner opts in to its exit. The pool rules of phases 1 and 2 read pools; a vault has no range, no swap and no
volume, so most of them do not apply to it. Live today, the Packaging rows that fire are on USDC/USDT (EEL about 103k
against 600k; its 0.21M TVL was under the 2M floor, which D15 removes for our pools along with the phase 1 floor row,
`RISK_POOL_TVL_FLOOR`, in the same change that drops it from `decide`). Those rows do not move it out (D12, Brais
1 Nov): the position stays as it is until the vault replaces it. Same contract as the other phases: shadow only, `Decision.shadowRisk` outside the premise
hash, nothing acts (constitution VI). Gate: the policy lists `packaging:vaults` in `policy.shadow` (v7 does), never
`guards.mode`, so LC-T9 flipping `guards.mode` to `enforce` leaves the vault rows in shadow; the operator supplies
`Observation.vaultShadow` only to such a policy.

Facts read on Base at block 53,424,812 (2 Nov 2026), which the rows below rely on:

- `vault:gtUSDCp` (`0xeE8F…4b61`): MetaMorpho v1.0. `lostAssets()` reverts (it is a v1.1 getter), so a market's
  realized bad debt lowers that market's `totalSupplyAssets`, the vault's `totalAssets()` and its share value: the
  share value is this vault's loss signal. Shares have 18 decimals (`convertToAssets(1e18)` = 1,118,199, 1.118 USDC);
  `totalAssets()` 401.48M USDC; 8 markets in `withdrawQueue`; timelock 7 days; no `paused()` getter (MetaMorpho has no
  pause).
- `vault:waBasUSDC` (`0xC768…DBD6`): static aToken v2 on aBasUSDC. Shares have 6 decimals; `paused()` exists (false);
  `totalAssets()` 234,199 USDC, the wrapper's own holders only. Its rate is the reserve's normalized income. The Aave
  Pool (`0xA238…d1c5`, `POOL_REVISION` 11) books bad debt as a reserve deficit (`getReserveDeficit(USDC)` = 30.88 USDC),
  not through the index, so this vault's share value does not fall on a loss: its loss signal is the deficit. The
  reserve runs virtual accounting: `getVirtualUnderlyingBalance(USDC)` = 15,589,686 USDC against
  `USDC.balanceOf(aToken)` = 15,590,003 USDC (the difference is donated USDC that cannot be withdrawn). aUSDC
  `totalSupply()` 189.96M. Configuration: active, not frozen, not paused.

Which pool rule applies to a vault:

| Phase 1-2 rule | On a vault |
|---|---|
| TVL floor | no: removed for every pool and vault Mamoru chose (D15, Brais 2 Nov) |
| TVL change 1d/7d/30d | yes, on the money the vault is exposed to: gtUSDCp `totalAssets()`; waBasUSDC the reserve's aUSDC `totalSupply()` (the wrapper's own 234k moves with one holder). Same thresholds as the stables bucket (`RISK_VAULT_TVL_DROP`) |
| Volume, V/TVL | no: a vault has no trading volume |
| EEL, exit slippage | no: a redeem pays the vault's rate, without price impact. Exit liquidity below replaces them |
| Position ratio | yes, against the liquidity the vault can pay out now (below), with its own code `RISK_VAULT_POSITION_RATIO` |
| Depeg (`RISK_DEPEG_SAVINGS`) | unchanged: the vaults hold USDC, so a USDC depeg is the account's savings asset |

Loss in bp, per vault, at each read:

- gtUSDCp: `s = convertToAssets(10^vault.decimals())` (`10^18`, never the asset's `10^6`, which rounds to 0 or 1
  wei); `loss = (mark - s) / mark` in bp, where `mark` is the highest `s` seen.
- waBasUSDC: the larger of the same share-value loss (zero while Aave keeps the index rising) and the net deficit
  loss: `(deficit - deficitBase) / aUSDC.totalSupply()` in bp, minus the interest the reserve paid since `deficitBase`
  was set (`getReserveNormalizedIncome(USDC)` now over `indexAtBase`, in bp), floored at 0. When the net deficit loss is
  0 (the deficit was covered, or interest earned it back, as gtUSDCp's share value does), `deficitBase` and
  `indexAtBase` move to the current values. So the same loss clears at the same pace on both vaults. The deficit and
  aUSDC supply are both in USDC base units (6 decimals; 30,875,031 = 30.88 USDC on 2 Nov).
- Bootstrap: `mark`, `deficitBase` and `indexAtBase` are per vault, not per account, and start at the first phase 4
  read of that vault (a sibling no account has deposited into has them too), and that read's time is stored as the
  vault's `bootstrappedAt`. Existing v7 holders need no history before that read. A missing `vaults.json`, or one that is not valid JSON, bootstraps again and `/ops` shows it once as a store reset
  (any latch it held, and any alert it still had due, is gone, so the reset is visible, not silent; with a lost
  `alerts.json`, below, these are two of the three cases where a due alert is not posted, the third a reset `purga.json`). After a reset each vault's `appliedRebaseId` starts at the log's last id, so old
  requests are not processed again.

Episodes (D14): an episode opens at the first read with loss above 1 bp and closes at the first read with loss at 0 or
below; every read in between belongs to it, whatever its depth, so a dip that lasts days is one episode. When an
episode opens, the engine compares the previous `lastDipOpenedAt` (the value before this read) with now, then stores
now in it. Episode state is per vault: `dipOpenSince` (null when no episode is open), `lastDipOpenedAt`,
`lossLatchedAt` (null when not latched).

Vault rows (every row is keyed by vault id, e.g. `vault:gtUSDCp`, never by bucket):

| Rule | Condition | Would-be action | Code | `window` |
|---|---|---|---|---|
| Share value dip | `dipOpenSince` not null and not latched (the whole episode, including reads between 0 and 1 bp) | no new deposits into that vault (an entry block on that vault id; the sibling keeps taking deposits); an internal alert when the episode opens: one `ops-mamoru` post and an `/ops` row with vault, loss in bp and time. Nothing to the owner (D14) | `RISK_VAULT_SHARE_DIP` | `30d` |
| Share value loss | latches when a read has loss of 10 bp or more, or an episode opens less than 30 days after the previous one opened. Latched until re-based (below) | EXIT the vault: `vault_redeem` of the account's whole holding to idle USDC or the healthy sibling; no deposit into it while latched; the same alert | `RISK_VAULT_SHARE_LOSS` | `30d` |
| TVL change | the measure above now vs 1, 7, 30 days ago at or under -12%, -20%, -30%. A window the series does not cover yet (after a bootstrap) is not evaluated and emits nothing; it is not unread | EXIT the vault | `RISK_VAULT_TVL_DROP` | `1d`, `7d`, `30d` |
| Exit liquidity | the account's holding `convertToAssets(shares)` exceeds `min(maxWithdraw, payable liquidity)` by more than max(1 bp of the holding, 1 USDC) for 6 h: the vault cannot pay the whole holding now. The tolerance absorbs ERC-4626 rounding; payable liquidity is taken alongside `maxWithdraw` because a static aToken may report `maxWithdraw` without checking the reserve's cash | EXIT the vault (what cannot be paid waits, as v7's `DECIDE_WAIT_VAULT_LIQUIDITY`) | `RISK_VAULT_EXIT_LIQUIDITY` | `6h` |
| Position ratio | the account's holding over the vault's payable liquidity above 1,000 bps | EXIT the vault | `RISK_VAULT_POSITION_RATIO` | none |
| Paused | waBasUSDC only: the reserve's configuration has active = 0 or paused = 1, or the wrapper's `paused()` is true. MetaMorpho has no pause: a market that cannot pay shows in exit liquidity, a market removed with a loss in the share value | no new deposits; the exit waits until a redeem is possible | `RISK_VAULT_PAUSED` | none |
| Frozen | waBasUSDC only: the reserve's frozen bit is set. Withdraw and repay still work, supply reverts | no new deposits only, never an exit | `RISK_VAULT_FROZEN` | none |
| Unreadable | any read above failed or is older than 2 h | no new deposits, no exit; an unread read never opens, closes or latches an episode, never moves `mark`, `deficitBase` or `indexAtBase`, and leaves `exitShortSince` as it was | `RISK_VAULT_UNREAD` | none |

Re-base (clearing a latch, or a dip we accept): a realized loss leaves the share value under the old mark for days or
months, so the latch never clears by itself. In shadow, an `/ops` action "re-base vault" (operator side, Ot or Brais)
sends a signed operator route (`POST /ops/vault-rebase`) carrying the baseline
it accepts: the vault's share value, deficit and index of the latest read shown in `/ops`, and that read's block. Under
an in-process mutex, taken inside the phase 4 lock below, the operator truncates the log back to its last newline (dropping a line torn by a crash), takes
`id` = 1 + the largest of the log's last parseable id and every vault's `appliedRebaseId` in `vaults.json` (a lost or emptied log never hands out an id the step would skip), and appends `{ id, nonce, vault, by, at, accepted }`, so two requests at once get two ids.
The next vault step first evaluates the vault's fresh read as usual (episodes, latch and `alertsDue` move first), then
takes each request whose id is above that vault's own `appliedRebaseId` (one counter per vault). It applies it only
when the fresh read's loss against the accepted baseline is at most 1 bp and the request is under 24 h old: `mark` to
the share value of that read, `deficitBase` and `indexAtBase` to its deficit and index, and `lossLatchedAt`,
`dipOpenSince` and `lastDipOpenedAt` cleared and `rebasedAt` set to the time it is applied (accepting a loss starts the 30-day count again). A
request that fails the check is rejected, with the reason shown in `/ops`, so a later loss is never absorbed by an
older re-base. Applied or rejected, that vault's `appliedRebaseId` rises to the request's id. A vault whose read is
unreadable takes no request and keeps its counter, while the other vault takes its own; `/ops` shows the waiting
ones. A newline-terminated line that does not parse is skipped and shown in `/ops`, wherever it is in the log. When the rows leave shadow (D5, #56), the owner's resume of that vault does the same; that action is
specified with LC-T9.

Would-be action and re-entry (D4, Brais 1 Nov: "sal de ese pool que se está poniendo feo, quédate en idle buscando otro
similar o espera a que ese mejore"):

- Every vault row is specific to one vault, so its share may go to the other vault of the bucket when that one passes
  every row (the rule of "Interaction with #127": pool-specific cause, healthy sibling). Both vaults failing, or a
  market cause (`RISK_DEPEG_SAVINGS`), keeps the share as idle USDC in the Safe until re-entry.
- A redeem the vault cannot pay waits, as in v7 (`DECIDE_WAIT_VAULT_LIQUIDITY`); the shadow row records how much
  would have been stuck.
- Re-entry into a vault left on a rule: the phase 3 cooldown (stables 7 d) and re-validation apply, keyed by the vault
  id like the entry block, and `RISK_VAULT_SHARE_LOSS` additionally needs the re-base above.

State and side effects: a phase 4 shadow store of its own in the operator's state directory (`shadow-vaults/`), in
four parts (phase 3's `rotation/` files and `purga.json` live beside them under the same rules), each its own file with
exactly one writer, written only by the instance holding the lock below. The JSON
files are written whole to a temporary file and renamed (atomic); each carries a schema `version`:

- Vault part (`vaults.json`): the series (share value, deficit, index, the TVL measures, 31 days like the pool TVL
  series), the latest payable liquidity per vault, `mark`, `deficitBase`, `indexAtBase`, the episode fields, `bootstrappedAt` and `rebasedAt` per vault (`rebasedAt` null at
  bootstrap, and null when migrating a version without it), `appliedRebaseId` per vault and `alertsDue`. The entry block is not stored: it holds exactly while the dip,
  latch, paused, frozen or unread row fires for that vault, or one of its exit rows (TVL change, exit liquidity,
  position ratio) fires, since no new money goes into a vault the bucket would leave; so closing an episode lifts it. An alert id is `<vault>:<open|latch>:<block of the read>`, unique and the same
  after any reset; `alertsDue` drops an id only once it is in `alerts.json`. Written
  only by the vault step, a
  pure function in `decide` (`vaultShadowStep(store, reads, requests, sentAlertIds) -> store`), run once per hourly vault read,
  before any account review uses that read. It alone opens and closes episodes, latches, applies re-base requests and
  marks the alert due, so an episode alerts once, not once per account.
- Account part (`accounts/<account>.json`, one file per account): `exitShortSince` per vault for the 6 h
  exit-liquidity hold (null when the holding is payable). Written only by that account's review, which gets the vault part read-only in the observation
  (`Observation.vaultShadow`) and returns its own entry next to `Decision.shadowRisk`.
- The vault part keeps the latest read of each vault with the rest (persisted, so a restart does not lose a pause or an
  identity state), and the account review receives it, never hashed:

  ```ts
  vaultShadow?: {
    vaults: Record<string, {                       // vault id, e.g. 'vault:gtUSDCp'
      read: { at: bigint; block: bigint; ok: boolean; // ok false: some read failed; values below are absent then
        shareValue?: bigint; deficit?: bigint; index?: bigint; tvlMeasure?: bigint; payableLiquidity?: bigint;
        paused?: boolean; frozen?: boolean; active?: boolean;   // waBasUSDC only
        identity: { code: boolean; asset: string } | null }   // null: identity read failed
      mark?: bigint; deficitBase?: bigint; indexAtBase?: bigint // absent before bootstrap
      dipOpenSince: bigint | null; lastDipOpenedAt: bigint | null; lossLatchedAt: bigint | null
      bootstrappedAt: bigint | null; rebasedAt: bigint | null   // bootstrappedAt null: no ok read yet
      tvlAgo: { '1d'?: bigint; '7d'?: bigint; '30d'?: bigint } // absent: the series does not cover that window yet
    }>
    account: { exitShortSince: Record<string, bigint | null> } // from accounts/<account>.json, the previous review's
  }
  ```

  Every v7 vault has an entry from the first step on, bootstrapped or not. Bootstrap happens only on a read with
  `ok: true`; until then the entry has `bootstrappedAt: null` and no bases, and the review gives `RISK_VAULT_UNREAD`
  (no new deposits, no exit). The review, not the step, decides staleness: a read whose `at` is more than 2 h before
  the review's block timestamp is unread whatever its `ok`, so a vault step that stopped running cannot leave an old
  read looking fresh. A vault missing from `vaultShadow` altogether is unread too.
- Re-base log (`rebase.jsonl`): appended only by the operator's `/ops/vault-rebase` route; the vault step reads it and
  never writes it. The step takes only lines that end in a newline: an unterminated last line (an append in progress,
  or one cut by a crash) is not read, and the route's truncation drops it before the next append, so no id is ever
  applied and then reused. No line of the log ever resets anything.

Single holder and containment: every phase 4 writer (vault step, account part writes, re-base route, alert sender)
runs only in the instance holding an OS advisory lock on `shadow-vaults/` (`flock(2)` through `bun:ffi`, fd opened
with `O_CLOEXEC` so no child keeps it, on the operator host's local volume), released by the kernel when the process
exits, so a crash leaves no stale lock. Every vault step and every re-base request first tries the lock without
blocking; an instance that just acquired it reloads `vaults.json`, `purga.json`, `alerts.json`, the account files, the `rotation/` files and the log from
disk before writing. An instance without the lock (an overlapping deploy, or any lock error, including a filesystem
without `flock`) skips phase 4 for that step, writes no phase 4 file, says so in `/ops`, and runs everything else as
usual; it never refuses to start, and it takes over at its next step once the holder exits. Any phase 4 error (lock,
file read, a file that fails schema validation, the step, the observation build, the vault rows) is caught at the
operator level: the account's live decision runs without vault rows and with `RISK_VAULT_UNREAD`, and `/ops` shows a
store error. Files and versions: a missing file or one that is not valid JSON is the reset case above. A file of an
older `version` is migrated on load by the new code, so a deploy keeps every latch, mark and counter. A file of a newer
`version` than the running code knows (a rollback), or valid JSON that fails its own version's schema, is a contained
error: the file is left untouched, phase 4 is skipped with `RISK_VAULT_UNREAD`, and `/ops` shows it until a forward
deploy or a fix; it never resets. The holder keeps one lock fd for its whole life (a second `open` plus `flock` in the
same process would contend with its own lock). The same file rule holds for `alerts.json`: a newer version or a
schema failure is contained (nothing posted, nothing rebuilt), never the rebuild above. A contained error in one
account file skips phase 4 for that account only; in `vaults.json` or `alerts.json`, for every account. A contained
error in `purga.json` stops the Purga alerts only (the account rows still compute); in a `rotation/` file, phase 3 for
that account only.

Re-base route: `GET /metrics`'s signature (`packages/operator-auth`, HMAC over method, path and unix minute; checked
2 Nov) does not cover a body, so the route gets a body-binding variant in `operator-auth`: hex HMAC-SHA256 of
`POST /ops/vault-rebase <unixMinute> <sha256 of the body>` with `OPERATOR_SECRET`, current or previous minute accepted.
The body carries `nonce`, `vault` and `accepted`, so none of them can be changed without the secret, and the route
refuses a nonce already in the log. The route refuses the request (explicit error, nothing appended) on an instance
without the lock, and while `vaults.json` is in a contained error (it cannot read the counters for the id).
- Sent alerts (`alerts.json`): the ids of `alertsDue` already posted. Written only by the alert sender. Missing or not
  valid JSON, and `vaults.json` or `purga.json` existed before this step (a lost file, not a first run), it is rebuilt as "every id now in `alertsDue` of `vaults.json` and `purga.json` sent" (and not rebuilt
while either of them is in a contained error: the sender posts nothing until both read; a file that does not exist on
that operator, such as `vaults.json` on Monad, reads as empty, not as an error), shown once in `/ops`, so a lost file never re-posts
  history; on a first run (neither existed) an empty versioned `alerts.json` is written when the store is opened under the lock, before any step persists anything, so a later step never mistakes a first run for a lost file and the first alerts are posted, also after a failed first post.

None of it is bucket state, and neither `premiseHash` nor `decisionId` reads it. Alerts: the sender runs on every
operator whose policy lists `packaging:rotation` or `packaging:vaults`; after the vault part or `purga.json` is
persisted, it posts every id in `alertsDue` that is not in `alerts.json` and records each one right after its
post succeeds. A failed post (no crash) stays unsent and is tried again at the next step, every hour, until it
succeeds. A crash between a post and its record re-posts that one alert once at restart. So an alert is lost only by a reset of `vaults.json`, `purga.json` or `alerts.json` (each shown in `/ops`) and
repeats only after a crash. Alerts go out on the live operator only. The reset rule (a missing or unparsable file
bootstraps again, shown once in `/ops`) applies to `vaults.json`, the account files, the `rotation/` files and
`purga.json` only (a reset `purga.json` restarts `failingSince` at the next step, so a pool still failing posts once
more, shown in `/ops`). A Lab replay starts from an empty store, bootstraps at
its first read and sends nothing.

Data (operator, Base): per vault, hourly, at one block: code at the vault address and `asset()` (the Purga identity),
`totalAssets()`, `convertToAssets(10^vault.decimals())`, and
per account `balanceOf`, `convertToAssets(shares)`, `maxWithdraw`, `maxRedeem` (the last four already read by v7's
snapshot); for waBasUSDC also `paused()`, the Pool's `getReserveDeficit(USDC)`, `getReserveNormalizedIncome(USDC)`,
`getConfiguration(USDC)` and aUSDC `totalSupply()`. Payable liquidity, in USDC:

- MetaMorpho: for each market in its `withdrawQueue` (the idle market included: MetaMorpho v1.0 keeps idle funds as supply
  in it, and a redeem withdraws only from markets, so USDC sent to the vault contract itself never pays out), the smaller of the vault's supply in
  that market (`position(id, vault)` shares converted at the market's `totalSupplyAssets / totalSupplyShares`) and the
  market's free liquidity (`totalSupplyAssets - totalBorrowAssets` from `market(id)` on Morpho Blue).
- Aave static aToken: `getVirtualUnderlyingBalance(USDC)` on the Pool, the cash the reserve can pay under virtual
  accounting. Not `USDC.balanceOf(aToken)`, which counts donated USDC (316 USDC more on 2 Nov), and not
  `getReserveData`, which carries no cash figure.

No outside API.

`stables-lp` while held: the phase 1-2 rows keep running on USDC/USDT and are recorded, but they are not an exit
reason there. The exemption is keyed on the position kind `stables-lp`, not on the bucket, so the vault rows of the
same bucket are never exempt. The TVL change, volume, EEL, exit slippage and position ratio pool rows never propose or
offer an exit from a `stables-lp` position (D12, Brais 1 Nov: "deja el pool tal cual está [...] que no salga de los
pools de stables"); `/ops` shows them as informational. Depeg (freeze) and incident rows still apply. The rows become
moot once the vault holds the bucket.

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
  `RISK_POOL_STATS_UNREAD` and `RISK_POOL_DEPTH_UNREAD` (`RISK_POOL_TVL_UNREAD` was the floor's unread row and goes
  with it, D15, PR #213).
- **D9.** IL / rally exit (Packaging's price rules): shadow only.
- **D10.** ENY / APY exit: only once ENY leaves shadow.
- **D11.** Safety Score: dropped. Covered by incidents (LC-T13) plus the Purga re-run: before every re-entry
  (`REENTRY_REVALIDATION_SHADOW`) and while invested (`RISK_PURGA_RECHECK_FAILED`: identity at every review, and a
  Purga review by Ot or Brais older than 90 days fails; internal alert per pool at the start and every 7 days while it fails, no new deposits,
  never an exit by itself; Ot 2 Nov, recommended default while Brais has not answered).
- **D12.** Small pools and vaults (Brais, 1 Nov): a `stables-lp` position (USDC/USDT) is exempt from the Packaging
  exit rows only (TVL change, volume, EEL, exit slippage, position ratio): they are recorded, the position stays as it
  is, and the vault replaces it. Depeg (freeze) and incident exits (`RISK_INCIDENT_EXIT`) still apply to it (Brais,
  1 Nov: "déjalo así"). EEL and exit slippage do not apply to vaults (a redeem has no price impact; exit liquidity
  replaces them). The TVL floor is removed for our pools and vaults (D15).
- **D13.** Re-range cap (proposed): `range.maxPerWeek = 2` on live (#218, engineering setting from `/ops`), the
  Packaging's "2 rebalances per week". Lab-checked in LC-T11 before it is raised or removed.
- **D14.** Vault share value (Brais, 1 Nov): graduated, not absolute, counted in episodes. A loss episode under
  10 bp blocks new deposits into that vault and alerts us only (`ops-mamoru`, `/ops`), no owner-facing line; a loss of
  10 bp or more, or a second episode opening within 30 days of the previous one, exits the vault. On waBasUSDC the loss
  is the Aave reserve deficit, since its share value does not fall. Thresholds are Lab-checked before they leave shadow.
- **D15.** TVL floor (Brais, 2 Nov): the 2M Packaging entry minimum is removed for every pool or vault Mamoru chose and
  recommends (all policy pools, both v7 vaults), so no floor row is computed today. A pool not chosen by us (none
  exists) would need the floor back as a new row. The TVL change rows stay.
- **D16.** Action budget (Ot 2 Nov, recommended default): only rebalancing ops count (`rerange`, reduce, ratio
  convert). Entries and idle converts never count: they place deposits (the Packaging's BOP exception) or re-enter a
  pool, which the cooldown and re-validation rows already govern. Simpler than tracking each deposit to the op that
  places it, and no data crosses chains for it.
