# 007: An on-chain action policy that bounds what a leaked session key can lose

Ticket: otto/mamoru#151 (from the #140 audit, part 1, and the #149 review). Status: spec and PoC. Nothing is
deployed, no live grant changes, no engine or app code changes in this unit.

PoC: `contracts/action-policy/` (`MamoruActionPolicy.sol`, Foundry tests on a Base mainnet fork at block 52,700,000,
public archive RPC `https://mainnet.base.org`, never the operator's provider key). Run:

```
nix shell nixpkgs#foundry --command bash -c 'cd contracts/action-policy && ./install.sh && forge test -vv'
```

## Problem

The live grants (`packages/policy/src/grants.ts`, `conservador-live-v2` / `-v3`) are enforced on chain by
Rhinestone SmartSession with `UniActionPolicy`, `TimeFramePolicy` and `UsageLimitPolicy` only. Those check targets,
selectors, recipients and per-call caps. They cannot check a price, a position's identity, or a total across the
calls of one userOp. The #140 audit (part 1) found three ways a leaked or compromised session key loses value even
though every token stays addressed to the Safe:

1. **Price (High).** Swaps need only `amountOutMinimum > 0` and force `sqrtPriceLimitX96 == 0`. `manage-any`
   mints have no minimums, decreases have none. Whoever holds the key sandwiches the Safe's own swap or mint: push
   the pool, make the Safe trade at the pushed price, push it back. With flash-loaned capital and a self-submitted
   `handleOps`, all in one transaction. The operator's TWAP minimums (#46) bind the operator, not a leaked key.
2. **Positions (High).** `manage-any` decrease and burn accept any `tokenId > 0`; collect checks only the recipient.
   Any position the Safe holds, or is an approved operator for, can be decreased, collected and (through 1) sold.
3. **Batching (Medium).** `manage-any` mint and `convert-any` swap have per-call caps and no cumulative cap; usage
   is counted per userOp, so `approve, swap, approve, swap, ...` in one batch multiplies the cap by the batch length.

Today's bound is therefore the whole Safe value in the granted pools, plus anything deposited later.

## Decision

A custom SmartSession **action policy**, `MamoruActionPolicy`, added as a **second** policy on every action of the
Mamoru grants, next to `UniActionPolicy` (SmartSession requires every policy of an action to pass). It only adds
refusals. It enforces:

| | What | Where it binds |
|---|---|---|
| (a) price | `exactInputSingle`: `amountOutMinimum >= quoteAtTick(twap -/+ band) x (1 - fee)` and a non-zero `sqrtPriceLimitX96` no farther than the same band edge. `decreaseLiquidity`: `amount0Min`/`amount1Min` at least the position's amounts at the band edges (token0 at `twap + band`, token1 at `twap - band`). Mint: refused at execution when `|spot - twap| > band`. | Swap and decrease: calldata at validation; the router and the position manager enforce the minimums at execution. Mint: execution. |
| (b) positions | Decrease, collect, burn, increase only for a tokenId in the account's admitted set **and** still owned by the account. Mint goes through `MamoruActionPolicy.mint` (the grant names it instead of the manager's `mint`): the policy pulls the desired amounts, mints with the Safe as recipient, returns the rest, and admits the tokenId the manager returns. Pool and fee must be the grant's pool. Adding liquidity goes through `MamoruActionPolicy.increase` the same way (below). | Validation (admission read), execution (admission write; increase re-checks admission, owner and spot). |
| (c) budgets | Per account and pool, token0 and token1 spent by swaps (`amountIn`) and mints (`amountDesired`) are summed per window (`budgetWindow`, e.g. 1 day) and over the whole approval (the generation). Charged at validation, call by call, so every call of a batch counts and a reverted execution is not refunded. | Validation. |
| (d) renewal | Init data carries a `generation`, account-wide. A higher generation retires every lower-generation config of the account (all pools) on the next check, and a lower one cannot be enabled again. So every renewal re-enables all pools at the new generation; adding a pool without a renewal uses the current generation. The renewal uses a new session key (new permissionId, new ConfigIds). | Validation; key freshness is checked off chain at activation (below). |

### Adding to a held position (otto/mamoru#171)

The engine mints a new NFT for every entry; on c23e94e1 that left two WETH/USDC NFTs with the identical range,
each paying its own mint, collect and close. The manager's `increaseLiquidity` takes a `tokenId` and **does not
check who owns it**: the caller pays, the liquidity accrues to the NFT's owner. A session allowed to call it
directly could push the Safe's tokens into an attacker's position, so it is never a session action (the policy
refuses it, and refuses approving the manager). UniActionPolicy can only pin `tokenId EQUAL <id>`, which would mean
one grant, and one owner signature, per position.

`MamoruActionPolicy.increase(IncreaseLiquidityParams)` closes it with no grant per position. Called by the account
after approving the policy for at most the desired amounts, it requires: the tokenId is admitted for the account,
the account still owns it, the pool's config is at the current generation, and the spot is within `bandTicks` of
the TWAP (the mint's execution check). It pulls the desired amounts, calls `increaseLiquidity`, resets the
approvals and returns what the manager did not take. At validation, `checkAction` requires admission and ownership
and charges the desired amounts on the pool's budget, like a mint. Admission survives a renewal, so positions opened
under an older approval stay manageable under the new one.

`initializeWithMultiplexer` accepts only the SmartSession address it was deployed with: unlike `UniActionPolicy`,
this policy keeps account-level state (generation, budgets, admitted set) that an arbitrary "multiplexer" must not
write.

### Why a policy and not a constrained executor

An executor module (the session may only call `MamoruExecutor.swap/mint/...`, which calls
`executeFromExecutor`) would do every check at execution time and stay inside ERC-7562 validation rules. It is
also an installed module with authority over the whole Safe: a bug in it is a bug in the account. The policy can
only say no to calls `UniActionPolicy` already allows; its one active part is `mint`, which only ever pulls from
`msg.sender`, with approvals sized to the call and spent in full in the same batch. Smaller blast radius, smaller
audit. The executor is the fallback if the ERC-7562 point below ever matters.

### ERC-7562

`checkAction` runs in `validateUserOp`. It reads storage of other contracts (the pool's oracle observations,
`NonfungiblePositionManager.positions/ownerOf`) and `block.timestamp`. A public ERC-4337
mempool would reject such userOps. Mamoru bundles its own (`apps/mamoru-operator/src/bundler.ts`: simulate with
`eth_call`, send `handleOps` from the relayer), so this does not block the product. It does not weaken the
protection: an attacker who bypasses bundlers and calls `handleOps` directly runs the same on-chain checks. A move
to a public bundler or a third-party paymaster would need the executor variant.

### Validation vs execution (no time-of-check gap)

The TWAP over `[now - W, now]` cannot be moved inside the transaction (observations are written per block, and a
same-block swap only changes the tick that counts from the next second). So a swap minimum computed at validation
is the same one the router enforces at execution, even if the attacker orders a manipulation between validation
and execution in its own bundle. Decrease minimums are enforced by the manager at execution. The mint's spot check
runs at execution, right before the manager's call.

Decrease has no spot check of its own, and needs none. The minimums are the position's amounts at the band
edges; for a range that lies inside the band both are zero. That is still safe: liquidity converts at prices
inside its own range, never at the spot, so a decrease at a pushed spot returns what the range would have at the
nearest band edge or better. A spot pushed past an edge into a range that extends past it fails the edge minimum.
`test_narrowRangeDecreaseLossStaysInBand` pushes spot 2,000 ticks past a +-40-tick range and measures 0 bp loss at
TWAP value.

## How SmartSession calls it

Per action of a session, SmartSession stores `Policy[]`. The grant builder (`toSmartSession` in
`packages/account/sessions`) adds `{ policy: MamoruActionPolicy, initData: abi.encode(Init) }` after the
`UniActionPolicy` entry. At `enableSessions`, SmartSession calls
`initializeWithMultiplexer(account, configId, initData)` with `configId = hash(permissionId, actionId, account)`.
In `validateUserOp`, for each execution (single or batch, in order) it calls
`checkAction(configId, account, target, value, callData)`; a return other than 0 reverts with `PolicyViolation`.
`supportsInterface(type(IActionPolicy).interfaceId)` must be true at enable. Interface from
`erc7579/smartsessions` `contracts/interfaces/IPolicy.sol`; the deployed SmartSession version at
`0x00000000002B0eCfbD0496EE71e01257dA0E37DE` must be checked against it before T1 (HEAD has the ERC-7484 check on
action policies commented out; Mamoru's live accounts self-attest `TimeFramePolicy` and `UsageLimitPolicy`, and
would self-attest this policy the same way in `registryTrustCalls`).

Grant changes it implies (T2): the swap rule `sqrtPriceLimitX96 EQUAL 0` goes; the swap and mint rules
`amountOutMinimum/amount*Min GREATER_THAN 0` stay (harmless); `manage-any` names `MamoruActionPolicy.mint` and
approves the policy, not the manager; `enter-mint` the same; the per-position `manage` grant becomes unnecessary
(admission is on chain). With admission and budgets on chain, `manage-any` and `convert-any` can merge into one
session per pool, which halves the enable gas.

## Parameters (proposal, Lab to confirm in T5)

Per pool, owner-signed in the grant: `twapWindow = 1800 s` (= `execution.twapWindowSeconds`), band in ticks,
`budgetWindow = 1 day`, per-window budget `W_p = 1 x C_p`, per-approval total `T_p = 3 x C_p`, with `C_p` the
pool's share of the account cap (#149's turnover target: loss <= band x turnover cap per pair per approval).

| Pool | Fee | Band | Why |
|---|---|---|---|
| USDC/USDT 0.01% | 1 bp | 10 ticks (0.10%) | range +-0.2%; beyond ~100 ticks the pool is nearly empty (below) |
| USDC/cbBTC 0.05% | 5 bp | 100 ticks (1.0%) | = `maxTwapDeviationTicks`; the engine's own #46 minimum (50 bp) is tighter, so its swaps pass |
| WETH/USDC 0.3% | 30 bp | 100 ticks (1.0%) | same |

Oldest oracle observation at the fork block: 2,379,820 s / 65,584 s / 70,388 s; cardinality 1,000 / 2,000 / 2,000.
A 30-minute TWAP is available on all three. If a pool's history ever drops below `W`, `observe` reverts and the
policy refuses (fails closed, engine waits).

**Liveness cost.** When spot moves more than the band away from the 30-minute TWAP (a fast crash), the policy
refuses swaps, mints and decreases in that pool until the TWAP catches up. The #46 operator rule already waits in
the same situation, so the engine loses nothing it has today; the owner's passkey path is not behind this policy
and can always exit. T5 measures how often and how long exits wait on 2024-2026 data.

## Max loss with a leaked key

Every unit of value that crosses a priced action (swap, mint, decrease) can lose at most band + fee of it to a
sandwich at the band edge. Crossings per pool are bounded by the position value at activation `V_p` (each unit of
liquidity is decreased once unless re-minted) plus twice the total budget (mints and swaps both draw on it, and
re-minted liquidity can be decreased again):

```
L <= sum_p (band_p + fee_p) x (V_p + 2 x min(T_p, W_p x windows until revoked))
```

Live v3 weights 50/35/15, fully deployed (`V_p = C_p`):

| Account cap | Today (v2/v3 grants) | After, revoked within 1 day (`V + 2W = 3C`) | After, never revoked (`V + 2T = 7C`) |
|---|---|---|---|
| 1,000 USDC | up to ~1,000 (100%) | 18.5 (1.85%) | 43.2 (4.3%) |
| 100,000 USDC | up to ~100,000 (100%) | 1,850 (1.85%) | 4,320 (4.3%) |

By pool at 1,000: stables 0.11% x 1,500 = 1.65 / 0.11% x 3,500 = 3.85; btc 1.05% x 1,050 = 11.0 / 1.05% x 2,450 = 25.7;
risk 1.3% x 450 = 5.85 / 1.3% x 1,050 = 13.65. The bound is linear in band and in `T_p`: band 50 ticks on the two
volatile pools and `T_p = 2C` give 1.8% never revoked.

Measured on the fork (`test_manipulatedSwapReverts`): moving USDC/cbBTC by 500 ticks took 1.83M USDC; today's
grant then fills a 10,000 USDC swap 397 bp under the policy's floor (about 5% under TWAP). The policy refuses that
call at validation, and a call with the policy's minimum reverts in the router.

### TWAP manipulation cost (multi-block, Base)

To shift a W-second TWAP by d, the pool must be held about d away for the whole window: W / 2 s = 900 Base blocks.
Arbitrageurs close the gap every block, so each block costs the manipulator about `d/2 x A(d)` (the arbitrage it
gives away) plus `fee x A(d)` to push again, where `A(d)` is the capital that moves the pool by d. Pushing farther
for less time costs more (`A` grows with d). Measured `A(d)` at block 52,700,000 (`test_measureManipulationDepth`,
USDC in):

| Pool | 10 ticks | 100 ticks | 500 ticks | Cost to shift the 30-min TWAP by the band |
|---|---|---|---|---|
| USDC/USDT 0.01% | 55k | 120k | 121k | 10 ticks: (27.5 + 5.5) x 900 = ~30k USDC |
| USDC/cbBTC 0.05% | 42k | 384k | 1.83M | 100 ticks: (1,920 + 192) x 900 = ~1.9M USDC |
| WETH/USDC 0.3% | 840k | 8.4M | 40.8M | 100 ticks: (42k + 25k) x 900 = ~61M USDC |

What a shift buys: the extra loss is d x crossings. One 100k account, btc pool, one window: 1% x 105k = 1,050
against ~1.9M of cost. Not profitable per account. **It changes with the fleet**: session keys live in the
operator, so an operator compromise is every account at once. A 1% shift of the btc TWAP pays once the btc bucket
crossable in one window (`3 x C_btc` summed over accounts) exceeds ~190M, i.e. ~63M of btc bucket, ~180M of TVL at
35%. Below that, the per-account bound above holds for the whole fleet. Above it: tighter budgets per window, a
longer TWAP, or an operator-wide on-chain counter (a shared budget across accounts, a later unit). The stables pool
is cheap to push in spot (beyond ~100 ticks it is nearly empty), which is why its band is 10 ticks: a TWAP shift of
even 10 ticks costs ~30k, and buys 0.1% of crossings.

Not modelled: an attacker censoring arbitrage by filling Base blocks for 15 minutes, or a sequencer that colludes.
Both are visible and far more expensive than the gains above at today's sizes.

## Gas (fork, block 52,700,000, base fee 0.005 gwei)

| Op | Today | With the policy |
|---|---|---|
| `checkAction` exactInputSingle (validation) | UniActionPolicy only | +93,912 (oracle `observe`, quote, tick math) |
| `checkAction` decrease / collect / burn / approve | | +37,036 / +6,207 / +5,858 / +19,989 (cold) |
| Mint, execution | 378,824 (`NPM.mint`) | 615,688 (`policy.mint`: pull, approve, mint, refund, admit) |
| Increase, execution | (none: a second mint today) | 230,701 (`policy.increase`: pull, approve, increase, refund); `checkAction` 10,630 |
| `initializeWithMultiplexer`, per action | | 61,187 (renewal; first enable higher, cold slots) |

At 0.005 gwei, +330k gas is about 1.7e-6 ETH, under a cent; the L1 data fee does not change materially. The
userOp `verificationGasLimit` of engine ops grows by up to ~160k per batch (harvest: decrease, collect, approve,
swap). Enable gas is the one to watch: 14 actions per pool in the v2/v3 grant set, 42 for three pools; at 61-150k
per action the renewal batch adds about 2.6-6.3M gas against Base's 2^24 per-transaction cap. T1 measures it end to end; the merge of `manage-any` and `convert-any`
and one account-level config write per pool (instead of per action) bring it down.

## Audit surface

`src/MamoruActionPolicy.sol`, about 300 lines plus Uniswap's `TickMath`, `OracleLibrary`, `LiquidityAmounts`
(unchanged, pinned). Trust it adds: (1) a refusal it fails to make leaves today's exposure (additive design); (2) a
refusal it makes wrongly stops the engine, never moves funds; (3) `mint` is the one place it holds tokens and
allowances, for one call, from `msg.sender` only, with a reentrancy lock and approvals reset to 0; (4) account-level
state is writable only by SmartSession at enable, which needs the owner's signature. Review points: calldata
decoding of every selector, rounding at the band edges, budget arithmetic and epoch reset, generation handling,
`observe` failure modes, token transfer return values (USDC, USDT, cbBTC, WETH on Base).

## Upgrade and rollback

The contract is immutable and has no owner. A new version is a new address; moving to it, or back to the previous
one, is a renewal through the #33 `extend` route with a higher generation. The operator cannot switch an account's
policy by itself, which is the point. Kill switch per account: the owner's `removeSession` (revoke), as today.
Rollout follows spec 005 phase 2: new accounts first on a `conservador-live-v4` policy version, then the renew row
for existing accounts.

## Re-approval UX (#33 extend)

One passkey tap, nothing moves, same screen as the #149 renewal and the #127 cap raise. The batch: self-attest
`MamoruActionPolicy` (once per account, `registryTrustCalls`), `enableSessions` with a new session key and the v4
grants at `generation + 1`, `removeSession` for every old permissionId. Copy: the existing renewal lines plus one
sentence on what changes ("Mamoru can now trade only near the market price, and only the positions it opened").
Accounts that do not tap keep their v2/v3 grants and their exposure; the app shows the renew row until they do.

**Fresh key per renewal.** Off chain, in the activation code next to `SESSION_PERMISSION_ID_REUSED`: refuse a
session key that was ever enabled for the account; the operator deletes the old key once the renewal lands. On
chain, the generation retires every older config of this policy even if a `removeSession` were missing. The v2/v3
grants do not consult this policy, so their `removeSession` in the same batch is required.

## One signature: the permission tiers (Ot, 18-oct)

Goal: as automatic as possible, as few taps as possible, without giving up what the owner's signature protects.
The rule that makes it possible: **the owner signs envelopes, not operations.** Inside an envelope the policy
enforces the bounds on chain, so the engine needs no further signature; only widening an envelope or moving
money out needs the owner.

| Tier | What | Owner taps | Why it is safe |
|---|---|---|---|
| 0, inside the envelope | swap, mint, **increase**, decrease, collect, burn, harvest, compound, re-range, in the signed pools | **none**, ever | (a)-(c) on chain: price within the band of the TWAP, only positions it opened and the Safe still owns, budgets per window and per approval. Loss with a leaked key <= the bound above. |
| 1, widen the envelope | renewal (yearly, fresh key), new policy version, new pool, bigger budget, new chain | **one tap for all of them**, queued and signed together | Changes what a leaked key can do, so the owner decides. |
| 2, money out | withdraw, new withdrawal address (24 h timelock, #151), owner change | one tap each, never automated | The session can never send tokens anywhere but the Safe. |

What removes taps that exist or would exist today:

1. **No grant per position.** `increase` (above), and the per-position `manage` grant goes too: admission is on
   chain. #171 in production needs no signature beyond the v4 upgrade.
2. **One envelope for every chain.** SmartSession's `ENABLE` mode takes one owner signature over a
   `multichainDigest` of `ChainDigest[]` (chainId, sessionDigest); each chain checks its own entry
   (`getAndVerifyDigest`). Base, Ethereum and Monad sessions in one passkey tap. Needs: the Safe at the same
   address on each chain (same factory and salt) and the passkey verifier deployed there. To verify against the
   deployed SmartSession version before relying on it.
3. **Tier-1 changes ride on taps the owner already makes.** The app queues pending envelope changes (renewal due,
   v4 upgrade, a new curated pool, a budget near its total) and folds them into the next owner signature (a
   withdrawal, or the yearly renewal), listed line by line on the same confirm screen. A dedicated tap only when
   something blocks the engine (expiry, budget exhausted) and nothing else is pending.
4. **Budgets sized for a year.** `T_p` (per-approval total) is what forces an unplanned tap when the engine has
   turned the capital over enough times. T5 sizes it from a year of Lab turnover, and the app warns at 80 % so the
   top-up rides on point 3.
5. **Merged sessions.** `manage-any` and `convert-any` in one session per pool (admission and budgets are on chain),
   which halves enable gas and keeps a multi-pool, multi-chain renewal inside one transaction.

What does not change: the passkey is the only owner; the operator can never widen an envelope or move funds out;
an owner who does nothing keeps the engine running until the approval expires, then it stops (decided 17-oct).

## What the PoC shows (20 tests, all pass)

- `test_normalSwapPasses`, `test_normalMintDecreaseCollectBurnPass`: the engine's ops with the minimums from the
  policy's `swapBounds` / `decreaseMins` views pass validation and execute.
- `test_manipulatedSwapReverts`: today's swap calldata (`min 1`, limit 0) is refused; with the policy's minimum the
  swap reverts in the router at the manipulated price; a minimum 1 unit lower, a zero limit, or a limit past the
  band edge is refused.
- `test_mintRefusedWhenSpotManipulated`, `test_decreaseRefusedWhenSpotManipulated`.
- `test_unrelatedNftDecreaseReverts`: a position the Safe minted outside Mamoru, and one held elsewhere with the
  Safe as approved operator: decrease, collect, burn refused.
- `test_batchOverBudgetReverts`: the third 25k swap of one batch is refused (60k per window), a mint draws on the
  same budget, the window refills, the approval total does not.
- `test_narrowRangeDecreaseLossStaysInBand`, `test_supportsSmartSessionInterfaceIds` (smartsessions' `IActionPolicy`
  inherits `IPolicy`, so its interfaceId is `checkAction.selector` alone).
- `test_renewalRetiresOldGrant`, `test_onlySmartSession`, `test_measureManipulationDepth`, `test_gasDirectMintBaseline`.
- Increase (#171): `test_increaseAdmittedPositionPasses` (liquidity lands on the same NFT, the account pays exactly
  what the manager took, nothing stays in the policy), `test_directManagerIncreaseRefused` (the manager's
  `increaseLiquidity`, and approving the manager, are refused), `test_increaseUnadmittedOrForeignRefused` (a
  position the Safe minted elsewhere, and an attacker's position, refused at validation and at execution),
  `test_increaseRefusedAfterPositionLeavesTheSafe`, `test_increaseRefusedWhenSpotManipulated` (`SpotOutsideBand`),
  `test_increaseDrawsOnTheSameBudget`, `test_increaseRetiredByRenewal` (old config dead, admission kept).

## What the PoC does not show

The real SmartSession + Safe7579 path (enable with two action policies, ERC-7484 attestation, a batch userOp
through `handleOps`): the tests call the policy as SmartSession does (`msg.sender` = SmartSession) and execute from
the account address. No engine, precheck or grant code uses it yet. No Lab run of blocked exits.

## Tasks (none of them is started by this unit)

- T1 Lab: the TS scenario fixtures enable a v4 grant with both policies on a fork and run the engine's ops and the
  three attacks through `handleOps`; measure enable and renewal gas.
- T2 `packages/policy`: v4 grants (above), `Init` encoding in `toSmartSession`; `increase-any` names
  `MamoruActionPolicy.increase` (replaces #171's per-position Lab grant).
- T3 engine: swap minimum and price limit from `swapBounds` (or the same math off chain), decrease minimums from
  `decreaseMins`, mint through the policy. The TWAP drifts between the engine's read and the userOp's validation,
  so the engine computes its bounds at a narrower band (e.g. 0.8 x band): higher minimums, a tighter limit, still
  inside what the policy accepts a few blocks later.
- T4 precheck mirrors (a)-(c) so a refused call is not sent.
- T5 Lab: bands and budgets per pool against 2024-2026 data; how often exits wait.
- T6 third-party audit of the contract (open question).
- T7 deployment and the renew row: coordinator only, after T1-T6 and Ot's decision.

## Open questions for Ot

1. Third-party audit before mainnet? Recommendation: yes. It guards real funds and is ~300 lines; a focused audit
   is days, not weeks. Who and what budget?
2. Timeline: T1-T5 are an estimated week of agent work; the renew row needs every account's tap. Before or after the
   cap raise of spec 005 phase 2? Recommendation: before any cap above 1,000.
3. Bands and budgets: accept 10 / 100 / 100 ticks and 1C per day, 3C per approval as the starting point for T5?
4. License: the contract links Uniswap's GPL-2.0 libraries, so it is GPL-2.0-or-later inside an MIT repo. Accept, or
   pay for MIT reimplementations of the tick math (more audit surface)?
5. Fleet-wide cap: needed only above ~180M TVL by the estimate above. Park it?
6. Accounts that never tap: keep running them on v2/v3 grants, or stop the engine for them after a deadline?
