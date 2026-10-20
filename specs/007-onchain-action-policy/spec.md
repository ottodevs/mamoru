# 007: An on-chain action policy that bounds what a leaked session key can lose

Ticket: otto/mamoru#151 (from the #140 audit, part 1, and the #149 review). Status: spec, PoC, T1-T5 done, T6
audit (`results/t6-audit-claude-2026-10-18.md`) and its fixes (`results/t6-fixes-2026-10-18.md`) done; T7 code (the
GPT-6 P1s of #97, operator activation and renewal in consecutive owner transactions, the renew row, the budget usage
signal) in `results/t7-2026-10-18.md`. Nothing is deployed, no live grant changes.

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
| (a) price | One range [lo, hi] from two TWAPs of the pool's own oracle, a long (1,800 s) and a short (300 s) one: `lo = max(long, short) - band + 1`, `hi = min(long, short) + band` (T6 M-1, L-7), clipped to a fixed anchor where the Init has one (the stables pool: parity +- 40 ticks, T6 H-1). Refused outright when the range is empty (the TWAPs about 2 x band apart, or the price outside the anchor). `exactInputSingle`: `amountOutMinimum >= quoteAtTick(lo or hi) x (1 - fee)` and a non-zero `sqrtPriceLimitX96` no farther than the same edge. `decreaseLiquidity`: `amount0Min`/`amount1Min` at least the position's amounts at the edges (token0 at `hi`, token1 at `lo`). Mint: refused at execution when the spot sqrt price is outside [lo, hi]. | Swap and decrease: calldata at validation; the router and the position manager enforce the minimums at execution. Mint: execution. |
| (b) positions | Decrease, collect, burn only for a tokenId in the account's admitted set **and** still owned by the account. Mint goes through `MamoruActionPolicy.mint` (the grant names it instead of the manager's `mint`): the policy pulls the desired amounts, mints with the Safe as recipient, returns the rest, and admits the tokenId the manager returns. Positions minted elsewhere (v2/v3 grants, the owner, an earlier policy address) are admitted by the owner-signed `Init.admit` at enable, after `ownerOf == account` and a pool check (T6 M-4). Pool and fee must be the grant's pool. | Validation (admission read), execution and enable (admission write). |
| (c) budgets | Per account and pool, ONE value budget in the pool's stable token (T6 M-2): swaps (`amountIn`) and mints (`amountDesired`, both tokens), the other token valued at the range edge that prices it highest. A token bucket of capacity `perWindow`, refilled at `perWindow / budgetWindow` per second (T6 M-3), and a per-approval `total` (the generation). A renewal resets the total, not the bucket (T6 L-5). Charged at validation, call by call, so every call of a batch counts and a reverted execution is not refunded. | Validation. |
| (d) renewal | Init data carries a `generation`, account-wide. A higher generation retires every lower-generation config of the account (all pools) on the next check, and a lower one cannot be enabled again. So every renewal re-enables all pools at the new generation; adding a pool without a renewal uses the current generation. The renewal uses a new session key (new permissionId, new ConfigIds). | Validation; key freshness is checked off chain at activation (below). |

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

## Parameters (T5 measured, Ot decided 18 Oct 2026)

Per pool, owner-signed in the grant: `twapWindow = 1800 s` (= `execution.twapWindowSeconds`), `twapShortWindow =
300 s`, band in ticks, an anchor (below), `budgetWindow = 1 day`, bucket `W_p` (stables 5, btc 2, risk 3 x
`C_p`), per-approval total `T_p = 10 x C_p`, both in the pool's stable token, with `C_p` the pool's share of the
account cap. The proposal was `W_p = 1 x C_p`, `T_p = 3 x C_p`;
the T5 Lab run (`results/t5-bands-2026-10-18.md`) found real turnover over it on 1-6% of days and over `T_p` within
weeks. These values clear every measured peak day; `T_p = 10 x C_p` bounds a leaked key's loss near 13% of the cap
(formula below) against ~100% today. A usage-triggered renewal asks the owner before `T_p` binds. The grant-level
(UniActionPolicy) cumulative caps follow `T_p`, so these budgets are the ones that bind. Adjustable as data comes in.

| Pool | Fee | Band | Anchor | Why |
|---|---|---|---|---|
| USDC/USDT 0.01% | 1 bp | 10 ticks (0.10%) | tick 0 +- 40 (parity; the pool sat at 14) | range +-0.2%; beyond ~50 ticks the pool is nearly empty, so its TWAPs are cheap to move (below) |
| USDC/cbBTC 0.05% | 5 bp | 100 ticks (1.0%) | none | = `maxTwapDeviationTicks`; the engine's own #46 minimum (50 bp) is tighter, so its swaps pass |
| WETH/USDC 0.3% | 30 bp | 100 ticks (1.0%) | none | same |

The anchor and the measurement behind it are in `results/t6-fixes-2026-10-18.md` (H-1). Oldest oracle observation at
the fork block: 2,379,820 s / 65,584 s / 70,388 s; cardinality 1,000 / 2,000 / 2,000. Enable refuses a pool whose
`observationCardinalityNext` is under `twapWindow` (the ring must hold the window even with a dust swap in every
1-s block, T6 L-4): the deploy step (`script/Deploy.s.sol`) raises all three to 3,600 first. If a pool's history
ever drops below `W`, `observe` reverts and the policy refuses (fails closed, engine waits).

**Liveness cost.** When spot moves more than the band away from the TWAPs (a fast crash), the policy refuses swaps,
mints and decreases in that pool until they catch up; when the two TWAPs are more than about 2 x band apart, or
USDC/USDT is ~0.5% off parity, it refuses every priced action in the pool. The #46 operator rule already
waits in the first case, so the engine loses little it has today; the owner's passkey path is not behind this
policy and can always exit. T5 measured the single-TWAP case on 2024-2026 data; the two-TWAP and anchor refusals,
and the summed daily value against `W_p`, are not measured yet (T7 Lab follow-up).

## Max loss with a leaked key

Every unit of value that crosses a priced action (swap, mint, decrease) can lose at most `band + fee + lag` of it
to a sandwich at the range edge, where `lag` is how far the 5-minute TWAP trails the market in the adverse
direction (the range takes the safer of the two TWAPs, so the 30-minute lag no longer counts). Crossings per pool
are bounded by the position value at activation `V_p` (each unit of liquidity is decreased once unless re-minted)
plus twice the budget spent (mints and swaps both draw on it, and re-minted liquidity can be decreased again).
The budget is one value per pool and a token bucket, so in the `tau` seconds from a leak to the revocation it
spends at most `W_p x (1 + tau / budgetWindow)`:

```
L <= sum_p (band_p + fee_p) x (V_p + 2 x min(T_p, W_p x (1 + tau / 1 day)))
```

Agreed parameters (Ot, 18 Oct): `W_p` 5 / 2 / 3 x `C_p` per day, `T_p = 10 x C_p`, weights 50 / 40 / 10
(`conservadorLiveV4`), fully deployed (`V_p = C_p`):

| Account cap | Today (v2/v3 grants) | Revoked within minutes | Within 1 hour | Within 1 day | Never revoked |
|---|---|---|---|---|---|
| 1,000 USDC | up to ~1,000 (100%) | 36.2 (3.6%) | 37.4 (3.7%) | 66.3 (6.6%) | 127.1 (12.7%) |
| 100,000 USDC | up to ~100,000 (100%) | 3,615 (3.6%) | 3,741 (3.7%) | 6,625 (6.6%) | 12,705 (12.7%) |

By pool at 1,000, never revoked: stables 0.11% x 21 x 500 = 11.6; btc 1.05% x 21 x 400 = 88.2; risk 1.30% x 21 x 100
= 27.3. Within a day: stables 11.6 (`T_p` binds), btc 1.05% x 9 x 400 = 37.8, risk 1.30% x 13 x 100 = 16.9. The
bound is linear in band and in `T_p`. The audited T4 accounting (one budget per token, fixed UTC epochs) gave 24.8%
never revoked and up to 12.6% revoked within minutes.

Not counted in the table: the 5-minute TWAP lag; a paid TWAP shift (next section; on stables at most the anchor
edge, about 0.55% per crossing (0.40% + today's 0.14% off parity + fee) instead of 0.11%, which would make the
never-revoked figure 17.3%); and userOp gas, below.

**Gas (T7).** Every v4 session carries `MamoruGasPolicy` (T6 L-1, T7 P1 2/4), which caps the priority fee,
`maxFeePerGas` and the three gas limits, so one op takes at most `c_op = maxFeePerGas_cap x (verification + call +
preVerification limits)` = 0.1 gwei x 5.2M = 5.2e14 wei from the Safe, whatever the basefee. The bound becomes

```
L <= (the token bound above) + min(E, U x c_op)
```

with `U` the usage limits of the sessions (108,000 ops for `conservadorLiveV4`) and `E` the native ETH the Safe holds
plus its EntryPoint deposit. `U x c_op` is 56 ETH, so `E` binds: the relayer tops the Safe up to 5e-4 ETH at
activation only, about one op at the cap (~1.3 USDC at 2,500 USD/ETH, 0.13% of a 1,000 USDC cap). Gas is native ETH
only; WETH and the other tokens are not reachable through it.

Measured on the fork (`test_manipulatedSwapReverts`): moving USDC/cbBTC by 500 ticks took 1.83M USDC; today's
grant then fills a 10,000 USDC swap 398 bp under the policy's floor (about 5% under TWAP). The policy refuses that
call at validation, and a call with the policy's minimum reverts in the router.

### TWAP manipulation cost (Base, measured)

A deviation of D ticks held for t seconds moves a W-second TWAP by D x t / W. The T4 spec assumed the pool had to
be held about d away for the whole window. The T6 audit (H-1) and the fork measurement showed that is false where
the pool is thin far from price: one block held 9,000 ticks away moves the 30-minute TWAP of USDC/USDT by 10 ticks
(the whole band) for ~25 USDC of fees and 127k of the attacker's own capital, and one block held 90,000 ticks away
moves USDC/cbBTC by 100 ticks (its band) for ~8.8k of fees and 13.5M of capital
(`results/t6-fixes-2026-10-18.md`, `test/H1Measure.t.sol`).

What stops it is the two-TWAP range of (a). A recent push (last 5 minutes) moves the 5-minute TWAP six times more
than the 30-minute one and empties the range; an old push moves only the 30-minute one, which the range ignores on
the side that matters. What still gets through is one old and one recent push sized about 5:1, so both TWAPs move
together. On USDC/USDT those cost ~25 USDC each, so that pool's range is also clipped to a fixed anchor, parity +-
40 ticks. Measured cost to move the range by one band:

| Pool | Before (T4) | After (T6) | How |
|---|---|---|---|
| USDC/USDT 0.01% | ~25 USDC (one block) | cannot pass the anchor | two pushes (~50 USDC) move both TWAPs, but the range is clipped at parity - 40, or empty |
| USDC/cbBTC 0.05% | ~8.8k USDC (one block) | ~9k USDC of fees per 1%, <= 5 min | one push 60,000 ticks out 5-30 min earlier, one 30,000 in the last 5 min: ~10M own capital, two block boundaries won |
| WETH/USDC 0.3% | > 1M | > 1M | ~0.6% of 18,670 WETH per 1,000 ticks |

A liquidity floor (refuse when the window's harmonic-mean liquidity drops, as it does in an empty range) was
measured and dropped: an attacker who mints ~1,000 USDC of its own liquidity at the pushed tick for the block
boundary keeps the harmonic mean at 87-98% of normal (`test_h1_jitLiquidityAtThePushedTick`).

What a shift buys: d x crossings during the <= 5 minutes it lasts. Per account that is far below the cost. **It
changes with the fleet**: session keys live in the operator, so an operator compromise is every account at once.
A 1% shift of the btc range pays once fleet-wide btc crossings in those minutes exceed ~0.9M: roughly 0.6-1.1M of
TVL at 40% btc, for an attacker who also holds ~10M. Above that: the fleet-wide on-chain counter (a shared budget
across accounts, open question 5), a smaller btc bucket, or a longer short window.

Not modelled: an attacker censoring arbitrage by filling Base blocks for 15 minutes, or a sequencer that colludes.
Both are visible and far more expensive than the gains above at today's sizes.

## Gas (fork, block 52,700,000, base fee 0.005 gwei)

| Op | Today | With the policy |
|---|---|---|
| `checkAction` exactInputSingle (validation) | UniActionPolicy only | +99,046 (oracle `observe` of two windows, quote, tick math, bucket) |
| `checkAction` mint (validation) | | +149,165 (the oracle read that values the budget) |
| `checkAction` decrease / collect / burn / approve | | +53,270 / +6,916 / +6,566 / +24,696 (cold) |
| Mint, execution | 378,824 (`NPM.mint`) | 593,308 (`policy.mint`: pull, approve, oracle check, mint, refund, admit) |
| `initializeWithMultiplexer`, per action | | 47,405 (renewal; first enable higher, cold slots; + one `ownerOf`/`positions` per admitted tokenId) |

At 0.005 gwei, +330k gas is about 1.7e-6 ETH, under a cent; the L1 data fee does not change materially. The
userOp `verificationGasLimit` of engine ops grows by up to ~160k per batch (harvest: decrease, collect, approve,
swap). Enable gas is the one to watch: 14 actions per pool in the v2/v3 grant set, 42 for three pools; at 61-150k
per action the renewal batch adds about 2.6-6.3M gas against Base's 2^24 per-transaction cap. T1 measures it end to end; the merge of `manage-any` and `convert-any`
and one account-level config write per pool (instead of per action) bring it down.

## Audit surface

`src/MamoruActionPolicy.sol`, about 680 lines with comments after T6 (runtime 23,673 bytes, 903 under the 24,576 limit), plus
Uniswap's `TickMath`, `OracleLibrary`, `LiquidityAmounts` (unchanged, pinned); `src/MamoruGasPolicy.sol`, ~90
lines (T6 L-1, a separate userOp policy; T7 adds the `maxFeePerGas` cap); `script/Deploy.s.sol` (both policies) (atomic deploy + registration, ring raise). Trust it adds: (1) a refusal it fails to make leaves today's exposure (additive design); (2) a
refusal it makes wrongly stops the engine, never moves funds; (3) `mint` is the one place it holds tokens and
allowances, for one call, from `msg.sender` only, with a reentrancy lock and approvals reset to 0; (4) account-level
state is writable only by SmartSession at enable, which needs the owner's signature. Review points: calldata
decoding of every selector, rounding at the range edges and the anchor clip, the bucket and the value
conversion, generation handling and `ConfigMismatch`, `Init.admit`, `observe` failure modes, token transfer return
values (USDC, USDT, cbBTC, WETH on Base).

## Upgrade and rollback

The contract is immutable and has no owner. A new version is a new address; moving to it, or back to the previous
one, is a renewal through the #33 `extend` route with a higher generation. The operator cannot switch an account's
policy by itself, which is the point. Kill switch per account: the owner's `removeSession` (revoke), as today. A
new address does not know which positions the old one admitted: the moving renewal names them in `Init.admit`
(owner-signed), as the first v4 renewal does for v2/v3 positions.
Rollout follows spec 005 phase 2: new accounts first on a `conservador-live-v4` policy version, then the renew row
for existing accounts.

## V2: MamoruActionPolicyV2 (otto/mamoru#151, #171)

The deployed contract (V1, `0x0083A9ca619f22A4f29704F97981dfFe8CD35215`) stays as it is; its source is not touched
(`verify-deployed-policy.ts` still matches it byte for byte). `src/MamoruActionPolicyV2.sol` is V1 plus three things,
each a refusal or a path a session could not take before:

- `increase(IncreaseLiquidityParams)`: the only way a session adds liquidity. The manager's `increaseLiquidity` does
  not check who owns the tokenId, so it is never a session action. V2 requires the tokenId admitted for the account
  and `ownerOf == account`, the current-generation config of that position's pool, then does what `mint` does: pull,
  approve the manager for exactly the desired amounts, spot inside [lo, hi] right before the call, reset, refund the
  balance delta. `checkAction(increase)`: admitted and owned, a non-empty range, the desired amounts charged to the
  pool's budget like a mint.
- A revoke-only guardian: immutable `GUARDIAN` (address(0) = none) may `pause(account)` / `unpause(account)`, nothing
  else. `pausedAt = generation + 1`, so the owner's next renewal ends a pause and an unpause never revives a retired
  generation. While paused `checkAction` refuses every action and `mint`/`increase` revert `AccountPaused`.
- The swap deadline `SwapRouter02.multicall(deadline, [])` (#140), accepted only in its exact 100-byte empty encoding,
  after the generation and pause checks. The v4 grants never carried it (V1 refuses it); v5 grants carry it under the
  policy, so a pause stops it too.

Size: at 10,000 optimizer runs V2 is over EIP-170; `foundry.toml` compiles only V2 at 1,000 runs (23,519 bytes).
`script/DeployV2.s.sol` deploys and registers it in one `deployModule` call; `GUARDIAN` is a required input.

Policy `conservador-live-v5` (`policies-v4.ts`): v4's pools, caps, bands and budgets; enter-swap + the deadline,
manage-any + increase + the deadline (15 actions per pool, 45 in all). Every earlier policy hash is pinned by test.
The operator resolves it only with `MAMORU_ACTION_POLICY_V2_ADDRESS` (never the V1 address); the D1 flag
`onchain_action_policy_v5` offers v2/v3/v4 accounts the move, a renewal on V2 at the V1 generation + 1 with every old
session revoked and the Safe's positions in `Init.admit`. The engine reads `isPaused` before each op (POLICY_PAUSED)
and adds to an admitted position within `range.increaseToleranceBps` instead of minting a second NFT.

Gas (`packages/scenarios/action-policy/t8-fork.ts`, Base fork): the move from v4 is three owner transactions,
11.31M / 10.45M / 4.44M; a v5 renewal 10.96M / 10.32M / 4.44M (all under 2^24 = 16.78M; v4 needs two). A guardian
pause is 47,894 gas. `checkAction(increase)` 65,525, `policy.increase` 237,723 (exec), the deadline 27,965 (cold).

## Re-approval UX (#33 extend)

One passkey tap, nothing moves, same screen as the #149 renewal and the #127 cap raise. The batch: self-attest
`MamoruActionPolicy` (once per account, `registryTrustCalls`), `enableSessions` with a new session key and the v4
grants at `generation + 1` (each pool's Init naming the account's open positions in that pool in `admit`),
`removeSession` for every old permissionId. The contract is deployed and registered in one
`ModuleRegistry.deployModule` transaction (`script/Deploy.s.sol`), and T7 checks `findModule(policy)` before any
account attests it. Copy: the existing renewal lines plus one
sentence on what changes ("Mamoru can now trade only near the market price, and only the positions it opened").
Accounts that do not tap keep their v2/v3 grants and their exposure; the app shows the renew row until they do.

**Fresh key per renewal.** Off chain, in the activation code next to `SESSION_PERMISSION_ID_REUSED`: refuse a
session key that was ever enabled for the account; the operator deletes the old key once the renewal lands. On
chain, the generation retires every older config of this policy even if a `removeSession` were missing. The v2/v3
grants do not consult this policy, so their `removeSession` in the same batch is required.

## What the PoC shows (`forge test`: 53 tests, 46 of them on the fork, all pass)

- `test/MamoruActionPolicy.t.sol` (13): the engine's normal swap, mint, decrease, collect and burn pass with the
  minimums from the policy's views; a manipulated-price swap, mint and decrease are refused or revert; unrelated
  and approved-but-foreign positions are refused; a batch over the budget is refused and the approval total holds
  across windows; renewal retires the old generation; only SmartSession initializes; capital to move each pool.
- `test/T6Fixes.t.sol` (17): one test per T6 finding (H-1 x5: one-block pushes on stables and btc, an old push,
  the spread push against the stables anchor, a dense-core control; M-1, M-2, M-3, M-4 x3, L-4, L-5, L-7, I-1,
  I-2, I-5).
- `test/T6Before.t.sol` (6): the same attacks against the audited T4 contract (`test/legacy/`), where they succeed.
- `test/Deploy.t.sol` (3): the T4 two-step registration can be front-run; `deployModule` with a deployer-prefixed
  salt cannot, and the ring raise lets the stables pool enable; the gas policy deploys the same way (T7).
- `test/MamoruGasPolicy.t.sol` (7, no fork): the userOp gas caps, `maxFeePerGas` included (T7).
- `test/H1Measure.t.sol` (7, measurement only): liquidity far from price, one- and N-block pushes, the arbitrage
  given away, JIT liquidity against a liquidity floor, the btc spread push.

## What the PoC does not show

In Foundry, the real SmartSession + Safe7579 path: the tests call the policy as SmartSession does (`msg.sender` =
SmartSession) and execute from the account address. The TS fork scenarios (`packages/scenarios/action-policy/
t1..t4-fork.ts`) do run that path through `handleOps`. Not shown anywhere: refusal rates of the two-TWAP range and
the stables anchor on historical data, and whether an attacker can hold both ends of a Base block boundary.

## Tasks

- T1 Lab: the TS scenario fixtures enable a v4 grant with both policies on a fork and run the engine's ops and the
  three attacks through `handleOps`; measure enable and renewal gas.
- T2 `packages/policy`: v4 grants (above), `Init` encoding in `toSmartSession`.
- T3 engine: swap minimum and price limit from `swapBounds` (or the same math off chain), decrease minimums from
  `decreaseMins`, mint through the policy. The TWAP drifts between the engine's read and the userOp's validation,
  so the engine computes its bounds at a narrower band (e.g. 0.8 x band): higher minimums, a tighter limit, still
  inside what the policy accepts a few blocks later.
- T4 precheck mirrors (a)-(c) so a refused call is not sent.
- T5 Lab: bands and budgets per pool against 2024-2026 data; how often exits wait.
- T6 audit (Claude, `results/t6-audit-claude-2026-10-18.md`) and fixes (`results/t6-fixes-2026-10-18.md`). A
  second, independent review of the patched contract (GPT-6, xreview `--high-stakes`) is still to do.
- T7 code (`results/t7-2026-10-18.md`): the four P1s of GPT-6's review of #97 (v4 grants activatable, the gas policy
  on every v4 session, the guard bound to the configured addresses and the grant's pool, a `maxFeePerGas` cap), the
  operator's v4 activation and renewal as consecutive owner transactions behind `MAMORU_ONCHAIN_POLICY_V4=1`, the renew
  row's move from v2/v3, the usage signal on the policy budgets, `t7-fork.ts` and `e2e-v4.ts`. Deployment and turning
  the flag on: coordinator only, after Ot's decision.

## Open questions for Ot

1. Third-party audit before mainnet? Recommendation: yes. It guards real funds and is ~680 lines with comments
   after T6; a focused audit is days, not weeks. Who and what budget?
2. Timeline: T1-T5 are an estimated week of agent work; the renew row needs every account's tap. Before or after the
   cap raise of spec 005 phase 2? Recommendation: before any cap above 1,000.
3. Bands and budgets: decided 18 Oct (10 / 100 / 100 ticks, W_p 5/2/3 x C_p per day, T_p 10 x C_p). Open: the
   stables anchor (parity +- 40 ticks) and the summed-value budget against T5's peaks.
4. License: the contract links Uniswap's GPL-2.0 libraries, so it is GPL-2.0-or-later inside an MIT repo. Accept, or
   pay for MIT reimplementations of the tick math (more audit surface)?
5. Fleet-wide cap: after T6's measurement, needed above roughly 1M of TVL (a ~9k-USDC push shifts the btc range
   1% for 5 minutes; operator compromise), not 180M as estimated before. Plan it before the cap raise.
6. Accounts that never tap: keep running them on v2/v3 grants, or stop the engine for them after a deadline?
