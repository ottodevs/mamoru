# 012 plan: full harvest (r2)

Spec: `spec.md`. Tasks: `tasks.md`. Scenarios: `scenarios.md`. Cross-spec order: `specs/mumbai-execution.md`.

## What exists and is reused

| Piece | Where | Used for |
|---|---|---|
| Collect-only harvest | `packages/decide/src/harvest/index.ts:28` | R8 unchanged; R1 follows it |
| One op per review, precedence `exit > rerange > harvest > reduce > idle > entry` | `packages/decide/src/index.ts:243-259` | the sale slots after harvest |
| Idle volatile sale (principal) | `rerange/index.ts:365` | unchanged; must not take harvested-unsold |
| Vault deposit / redeem, drain band | `allocate/index.ts`, `rerange/index.ts:247-334`, `DRIFT_BPS` `:55` | R3 ceiling, R6 |
| Return home of remote money (#278, V4 only) | `allocate/index.ts:407-418`, `operator.ts:6368-6381` | R4 V4 path |
| V3 bridge limit (spec 011) | `SessionObs.bridgeLimit: {kind:'v3',perCall,amountLeft} \| {kind:'none'} \| {kind:'unknown'}` | R4 V3 path, fail closed |
| Live V3 Monad policy | `packages/policy/src/policies-monad.ts:75-93` `liveWmonUsdcMonadV6`: grants `[manageAnyV3Only(...)]` only | R4 V3: in code, no bridge-out on Monad; HT9 confirms on the signed session |
| V4 room | `budgetLeft(account,key,ratioBps)` `MamoruActionPolicyV4.sol:1500`; precedent `bridge-out.ts:1969` (margin) | R7 |
| Receipt facts per op, read once | `apps/mamoru-operator/src/yield-receipts.ts`, `state.ts` `StoredOp.facts`, `rerange?: true` | R1, R5, R9 |
| Vault valuation | `snapshot.ts:261-263` | R5 |
| Samples | `account_worked_samples` (0023, `t_s`), `fees_usd` added by 013 B5 | R5 intervals, 24 h accrued delta |

## Design

### R1, R2: harvested-unsold and the sale

- Operator state (`state.ts`, per account): `harvested: Record<chainId, Record<token, string>>`. On a confirmed harvest
  op: `+= facts.collected` of the volatile side. On a confirmed sale op marked `harvestSale: true`: `−= amountIn` sold
  (receipt). On any other confirmed engine op that spends that token (entry, re-range mint, swap): `−= min(harvested,
  amount spent)` — harvested tokens are consumed first, so the counter never exceeds what is still harvested and a
  later sale cannot reach principal. At each observation: `= min(harvested, balance)`.
- `harvestedSince: Record<chainId, Record<token, number>>` (unix s when the counter went from 0 to > 0; cleared at 0)
  is persisted in `state.ts` next to `harvested`, so it survives restarts.
- `Observation.harvested?: Record<RegistryName, { amount: bigint; since: number }>`.
- Decide: new `harvestSaleOf(obs, policy)` in `harvest/index.ts`. For each token with `harvested > 0`:
  `amount = min(harvested, balance)`; pool = a policy pool with that token, eligible (not `exitOnly`), first in policy
  order; grant `convertKey`; proposal kind `enter_swap` with `harvestSale: true`. If its value ≤ op cost x
  `costFactorBps` → no proposal, code `DECIDE_WAIT_HARVEST_SALE`. **Age limit:** `harvestedSince` per token (first
  harvest that made it > 0); after 7 days the sale goes as soon as its value > 1 × op cost (not 3×), so fees never wait
  forever; below 1 × cost it is dust and stays (shown in the idle total).
- Precedence: `exit > rerange > harvest > harvestSale > reduce > idle > entry`.
- Entries and `idleConvertOf` see `balance − harvested` for volatile tokens (principal only).

### R3: sweep

In `allocate()`, after the normal choice, if no proposal and `free − Σ waiting ≥ vaultMin`:
`amount = min(free − Σwaiting, ceiling − vaultBucketValue, vault room ratioBps×C − holding)`,
`ceiling = target + total × DRIFT_BPS / 10_000 − 1`. If `amount ≥ vaultMin` → `vault_deposit`. Chains without a vault
bucket skip.

### R4: idle USDC home

- `Observation.remote` gains `idle?: bigint` (remote Safe's USDC balance) and `idleSince?: number` (unix s, the first
  review it was ≥ threshold, reset when it drops below), read by the remote's own engine and carried to Base the way
  `value` is today.
- `allocate`: `returnDue` also when `idle ≥ entryMin && now − idleSince ≥ 6 h && !inFlight && ready`; amount = `idle`.
  The existing sleeve-over-target trigger stays.
- Anti ping-pong: the operator stores `returnedAt` per account and chain; `bridge_out` to that chain is not proposed
  for 24 h after it unless the remote's last review placed everything (`idle < entryMin`). Code `DECIDE_WAIT_BRIDGE`.
- V4: `askReturn` as today. V3: HT9 reads the account's enabled sessions on Monad (`isPermissionEnabled`, signed
  grants) on a fork of the live state. If a bridge-out session exists: return = `bridge_out` on the remote engine,
  clipped by `bridgeLimit` (`perCall`, `amountLeft`; `unknown` → no op, `DECIDE_WAIT_BRIDGE_LIMIT`). If not: no op,
  code `DECIDE_WAIT_RENEWAL`, the account listed in #107 as "needs a renewal" with the read as evidence. **Owner-accepted
  constraint** (PRD §5.1 "No: contracts", decision 4 within signed limits): a V3 session without a Monad bridge-out
  grant cannot be given one without the owner's signature; its USDC returns after the owner renews. Not a defect of
  this spec.

### R5, R9: event ledger

Migration `0024_income_events.sql` (coordinator numbers it):

```sql
CREATE TABLE yield_ledger_income (
  event_id TEXT PRIMARY KEY,          -- '<txHash>:<logIndex>' or 'vault:<chainId>:<account>:<vault>:<sampleT>'
  chain_id INTEGER NOT NULL,
  account_key TEXT NOT NULL,
  env TEXT NOT NULL CHECK (env IN ('prod','beta','test','unknown')),
  source TEXT NOT NULL CHECK (source IN ('harvest','re-range','vault-yield','backfill')),
  t_s INTEGER NOT NULL,               -- block time, or sample time for vault rows
  usd INTEGER,                        -- raw USDC; null = unpriced (counted as not counted)
  updated_at TEXT NOT NULL
);
CREATE INDEX yield_ledger_income_t ON yield_ledger_income (t_s);
CREATE INDEX yield_ledger_income_account ON yield_ledger_income (chain_id, account_key, t_s);
CREATE TABLE yield_ledger_vault_samples (
  chain_id INTEGER NOT NULL, account_key TEXT NOT NULL, vault TEXT NOT NULL, t_s INTEGER NOT NULL,
  shares TEXT NOT NULL, value_usdc INTEGER NOT NULL,
  explained INTEGER NOT NULL CHECK (explained IN (0,1)),   -- shares match engine-op flows
  PRIMARY KEY (chain_id, account_key, vault, t_s)
) WITHOUT ROWID;
```

- Fee events: one per Collect log in an engine op's receipt; source from the op (`harvest` intent → `harvest`;
  rerange, reduce, close → `re-range`). Insert-or-ignore on `event_id` (idempotent, no overwrite, no loss).
- Vault events: at each snapshot, per account and vault, with `e` = shares explained by engine ops (from the ERC-4626
  events decoded in HT6; 013 B4 reuses that decoding) and `pps` = assets per share:
  the interval is split at every engine flow inside it (each ERC-4626 Deposit/Withdraw gives its own
  `pps = assets / shares` at that block), and `usd = Σ_k e_k × (pps_k+1 − pps_k)` over the segments, `e_k` = explained
  shares held during segment k. Only explained shares earn in the ledger; shares outside `e` never enter any formula. `explained = 1` when `e` equals the holding (±1 wei), else 0 and the holding is `partial` (marker shown)
  with the yield of its explained part still counted. First sample: one `backfill` row
  `e × pps − netDepositedFromEngineOps` (0 explained shares → `usd = null`).
- Accrued uncollected LP fees are a level, not an event: read from the latest snapshot (`account_snapshot_latest.fees_usdc`);
  its 24 h change from `account_worked_samples.fees_usd` (013 B5).
- Definitions (one module, `apps/mamoru-app/src/api/earned.ts`, used by Portfolio and by 013):
  - Cutoff: per account t_a = its latest fee sample (for a sum over accounts, 013 plan §3.2 bounds the t_a near one T).
  - `total earned = Σ income(t_s ≤ t_a, all sources incl. backfill) + accrued at t_a` (a Collect after t_a is still in the
    accrued level at t_a: never counted twice)
  - `earned 24h = Σ income in the window (source ≠ backfill) + (accrued at t_a − accrued at t_a − 24h)`, window
    (t_a − 24h, t_a] (013 plan §3.2). Fee events count at block time. A vault-yield
    row covers an interval (prev sample, sample]: it is **prorated by the interval's overlap with the window**, so a
    48 h gap cannot put a whole interval in the figure. Inside an interval the split is an approximation (accepted by
    the owners); any vault interval longer than 2 h that overlaps the window (samples run every 10 min) marks the
    24 h figure `partial`. Accrued at a time = the nearest sample at or before it;
    missing → not counted. Approximate by decision (Ot and Brais, 6 Nov).
  - **History replay (HT7):** at migration, every Collect already in `yield_ledger_account_receipts` /
    stored op facts is written as an income event (`harvest` or `re-range` from its op, block time from the receipt;
    days without per-op detail → one `backfill` row per account and day with the day's collected total, **for every
    day**, so total earned keeps every dollar. Backfill rows stay out of the 24 h figure; if such a day is within 48 h
    of the migration, the 24 h figure is `partial` until it ages out). After the
    switch, each account's total earned ≥ its earned-so-far before it (scenario HRV-S22).
  - Any `usd = null` or `explained = 0` → `status: 'partial'` with the parts not counted.

### R7: room

`Observation.budget?: { room: bigint }`: V4 only, min of `budgetLeft`'s four values less a 2 % margin; read failure →
`room = 0n`. Decide: `reserve = LP value × 150 / 100` (the only factor; see spec HRV-R7); a reinvestment op with value `v` goes only if
`room − v ≥ reserve`. Exit, rerange, harvest, reduce, redeem are never gated.

### R10: marker

`YieldLedgerView` gains `earnedStatus: 'complete' | 'partial'` and `notCounted: ('vault-yield'|'accrued-24h')[]`.
`home.tsx:265` `<Earned …>` shows a small marker when `partial`. Proposed copy: "Vault yield not counted yet" with the
existing info affordance. Needs OK from Ot and Brais in the PR.

## Sequences

1. Review N: fees > 3x cost → `harvest`. Receipt: collected → `harvested += volatile`, events `harvest`.
2. Review N+1: `harvestSale` of `min(harvested, balance)` (or wait, R2). Receipt: `harvested −= sold`.
3. Review N+2: free USDC, room OK → entry for an under-weight bucket, else sweep (R3).
4. Snapshot: vault samples → `vault-yield` events.
5. Monad: steps 1–3 on the sleeve; idle USDC ≥ threshold for 6 h → return home (R4).

## Failure modes

| Failure | Effect | Handling |
|---|---|---|
| Sale reverts (slippage) | `harvested` unchanged | next review retries; existing backoff |
| V4 budget revert | op fails, gas spent | revert name decoded into the op record (HT5); R7 makes it rare |
| `budgetLeft` unread | no reinvestment | `DECIDE_WAIT_BUDGET` |
| Operator restart | `harvested` lost? | kept in `accounts.json` with the ops (same store as facts) |
| Vault op receipt unread | flows unknown for an interval | that interval's event `usd = null`, status partial |

## Data and deploy notes

- Migration additive, applied by the coordinator before the Worker that writes it.
- Operator: one redeploy per block for all merged 011/012/013 operator PRs (`operator:deploy <sha>`).
- Order: migration → operator → app Worker on beta; prod with the hackathon batch (`--min-soak-hours=0
  --hotfix="ethglobal-mumbai"`).
- No secret, contract or registry change. Decide and operator PRs get the two-reviewer gate.

## Constitution check

- I (no custody): no new grant or recipient; V3 return only with a session the owner already signed. Pass.
- IV: the sale is a V3 swap in a policy pool. Pass.
- V: sale and sweep pass today's gates. Pass.
- XI: one op per review. Pass.
- XVI: events recorded, not inferred; missing parts marked "not counted", never 0. Pass.
- XIX: CCTP standard, fee 0, recipient fixed by policy; returns measured in the bridge journal. Pass.
- XX: one sentence each: "sell what you harvested, nothing else"; "free USDC fills the vault up to its drain line";
  "reinvest only if V4 room still covers re-minting every position"; "idle USDC elsewhere for 6 h goes home". Pass.
