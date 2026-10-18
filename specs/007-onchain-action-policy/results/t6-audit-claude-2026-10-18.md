# 007 T6: security audit of MamoruActionPolicy (Claude, 18 Oct 2026)

Ticket: otto/mamoru#151, task T6. Target: `contracts/action-policy/src/MamoruActionPolicy.sol` (476 lines) at
`feat/151-t4-precheck-v4` `1311644`, with Uniswap `v3-core@6562c52` / `v3-periphery@b325bb0` (0.8 ports) as pinned
by `install.sh`. Read only: no repo change, no deploy, no transaction. `forge build` passes.

Method:

- **Solidity audit.** `solidity-auditor` ran in loop mode, 3 passes of 12 specialist agents each. Every bundle also
  carried spec 007 and the v4 grant builder (`packages/policy/src/v4-grants.ts`), because the threat model lives there.
- **Entry points.** `entry-point-analyzer` mapped the external surface.
- **Manual review.** I traced the main paths by hand:
  - SmartSession's `PolicyLib`, `ConfigLib` and `SmartSession.validateUserOp`, read from a source copy;
  - the operator bundler (`apps/mamoru-operator/src/bundler.ts`);
  - the activation path (`packages/account/sessions`, `packages/account/live`);
  - T5's band data (`policy-t5` worktree, `results/t5-bands-2026-10-18.md`).
- **Raw output.** The assembled skill report and per-pass run files are in the gitignored
  `contracts/action-policy/cache/audit/.solidity-auditor/runs/20261018-135049/`.

Nothing here was run on a fork. The numbers come from code, the spec's own measurements, and arithmetic. The items
marked "confirm on fork" need a T1-style scenario before anyone relies on them.

## Summary

| Severity | Count | Items |
|---|---|---|
| Critical | 0 | |
| High | 2 | H-1 one-block TWAP shift on the stables pool; H-2 activation path drops the policy (integration, outside the .sol) |
| Medium | 4 | M-1 band is measured from a lagging TWAP; M-2 per-token budgets double the bound; M-3 fixed epochs double the window; M-4 no admission for positions minted outside this deployment |
| Low | 7 | L-1 to L-7 |
| Info | 10 | I-1 to I-10 |

No path lets a leaked session key, a third party, or a caller of `checkAction`, `initializeWithMultiplexer` or `mint`
move tokens out of the Safe through this contract. Every recipient is pinned to the account, approvals can only go to
the router or the policy, and both of those pull only from `msg.sender`. The issues found are about the size of the
loss bound, not about theft:

- **Bound size.** The spec's "band + fee per crossing, crossings ≤ V + 2·min(T, W·windows)" is too optimistic in four
  independent ways (H-1, M-1, M-2, M-3).
- **Integration.** One integration path would remove the policy entirely (H-2).
- **Rollout.** One rollout gap stops the engine on every existing position (M-4).

Effect on the spec's own table, for a 1,000 USDC cap with weights 50/35/15:

- **Stale parameters.** The "revoked within 1 day" row still uses `W = C`. At the decided `W = 5/2/3 × C` it is
  about 3.8% with one window and about 7.0% with the epoch double-spend of M-3. The table says 1.85%.
- **Never revoked.** `V + 2T` gives about 13%, as stated. With the per-token double count of M-2 it becomes about 25%.
- **Not counted above.** Neither figure counts the TWAP lag (M-1) or a cheap TWAP shift (H-1).

## External surface (entry-point-analyzer)

| Function | Line | Access | State it writes |
|---|---|---|---|
| `initializeWithMultiplexer(account, configId, initData)` | 205 | `msg.sender == SMART_SESSION` (revert otherwise) | `_pool` cache, `generationOf`, `_config`, `_poolConfig`, `_budget` |
| `checkAction(id, account, target, value, data)` | 230 | `msg.sender == SMART_SESSION` (returns 1 otherwise, no write) | `_spend` (via `_spendOk`) |
| `mint(MintParams)` | 290 | public; acts only for `msg.sender` (`recipient == msg.sender`, needs `_poolConfig[msg.sender]` at the current generation) | token pulls/pushes/approvals, `admittedPool[msg.sender]` |

Views: `swapBounds`, `decreaseMins`, `spendOf`, `admittedPool`, `generationOf`, `supportsInterface`.

There is no owner, no upgrade path, no sweep, and no `receive`/`fallback`.

What SmartSession guarantees on the inputs (source copy checked):

- **`account`.** SmartSession always passes `account = msg.sender`: `ConfigLib.enable` at :98, and
  `validateUserOp` requires `userOp.sender == msg.sender` at :82. So anyone can write policy state only for their own
  address.
- **Enable signatures.** An enable signature is single use, because `$signerNonce[permissionId][account]++` at :147.
- **Executions.** Delegatecall and try mode are refused, and so is a nested self-`execute` (`PolicyLib` :196).
- **Policy results.** Every action policy must pass. A return of 1 or a revert becomes `PolicyViolation` or
  `PolicyCheckReverted`, which reverts the whole `handleOps`.

## High

### H-1. One block held far away shifts the stables 30-min TWAP by the band for a few USDC (`_twapTick`, L428-430; used by `_swapBounds` L377, `_decreaseMins` L392, `mint` L304)

**Cause.** `OracleLibrary.consult` returns the arithmetic mean tick, so a deviation D held for t seconds shifts a
W-second TWAP by D·t/W. The spec's cost model ("held about d away for the whole window, 900 blocks") assumes that
pushing farther costs more. The spec's own data for USDC/USDT says otherwise: A(100) = 120k and A(500) = 121k, so the
pool is nearly empty past about 100 ticks.

**Exploit.** An attacker sends the last swap of block N, which pushes USDC/USDT about 9,000 ticks. The pool writes
`slot0Start.tick` at the first tick-changing action of block N+1. The pushed tick therefore counts for one 2-s
interval, and the attacker reverts it with the first transaction of block N+1.

- **TWAP shift.** 9,000 × 2 / 1,800 = 10 ticks, which is the whole stables band, for 30 minutes.
- **Cost.** The capital comes back (agents estimate 28-150k in, depending on the tail liquidity). The fees are about
  2 × 1 bp of that, so 6-30 USDC, plus priority fees. The spec estimate is about 30k.
- **Repeat.** Pushes in k blocks add up to about 10·k ticks.
- **Use.** With the TWAP shifted by s, a leaked key, or the compromised operator for every account at once,
  sandwiches the Safe's swaps and mints at `twap' ∓ band`, which is s + band from the market. Decreases are not
  exposed, because LP holdings are worth least at the reference price (verified below).

**Unconfirmed.** Two things are not measured: the liquidity on USDC/USDT between 500 and ~10,000 ticks, and whether
the attacker can be the last tick-changing swap of a block. Base orders by priority fee, and backrunners compete.
That second point is a cost and a risk for the attacker, not a guard. Confirm on fork with
`test_measureManipulationDepth` extended to 1,000-20,000 ticks.

**Fix.** Pick one or more:

- **(a) Consistency check.** Also consult a short window, for example 60-300 s. Refuse when
  `|twapLong - twapShort| > band`, because an outlier moves the short mean W/w times more.
- **(b) Liquidity floor.** Refuse when `consult`'s `harmonicMeanLiquidity` (already computed and discarded) falls
  below a per-pool floor. Pushes into empty ranges crater it.
- **(c) Re-price the stables band.** Re-price the stables band and budgets against the real one-block cost. Also add
  `increaseObservationCardinalityNext` (see L-4).

### H-2. The production activation path drops MamoruActionPolicy, and the merged manage-any approve then has no spender rule (integration: `packages/account/sessions/index.ts:152-157`, `packages/policy/src/v4-grants.ts` `manageAnyV4Actions`)

**Cause.**

- **The approve rule.** T2 merged `convert-any` into `manage-any`. The volatile token's `approve` has an amount cap
  and **no `spender` rule** at the UniActionPolicy layer. Only this policy's APPROVE branch (L275-279) restricts the
  spender, to `ROUTER` or the policy itself.
- **The activation path.** `activationCall(grants, revoked)` builds every session with `toSmartSession(g)`, with
  **no second policy**. `packages/account/live/index.ts:84` uses it for live owner activation. Only the fork scenarios
  pass `{ policy, initData }`.

**Exploit.** Suppose T7 activates `conservadorLiveV4` through `activationBatch`/`activationCall` unchanged. A leaked
key can then send `approve(attacker, volatileConvertPerCall)` on WETH or cbBTC, and the attacker calls
`transferFrom`. That repeats once per userOp up to the usage limit. This is direct theft of the volatile leg, which
is worse than today's v2/v3. Decrease and burn also return to "any tokenId > 0".

**Fix.**

- **Make it fail closed.** `activationCall` must require the `SecondActionPolicy` whenever the `PolicyVersion` carries
  `actionPolicy`. Better, the v4 grant builder should return the wrapped `SmartSessionStruct`, so that a v4 grant
  without the policy cannot be built.
- **Or split the approve.** Do not let any action rely on the second policy for a property UniActionPolicy could
  enforce. Keep the volatile approve with a `spender == ROUTER` rule in a separate convert session, which costs one
  more session of enable gas.
- **Test it.** Add a test that fails if any v4 action has an `approve` without a spender rule and no
  MamoruActionPolicy.

## Medium

### M-1. The band is measured from a 30-min TWAP that lags the market, so a sandwich takes band + lag (`_swapBounds` L377-381; `mint` L303-305)

**Cause.** The swap limit and minimum sit at `twap ∓ band`. Validation never looks at spot, and `mint` checks only
that the (pushed) spot is within band of the TWAP. In a steady move the 30-min TWAP trails spot by about half the
move. Example: the market is at `twap + X` and the Safe sells token0. The attacker pushes spot down to `twap − band`,
and the Safe fills X + band under the market.

**Size.**

- **The spec's "Liveness cost" covers only one direction.** It says spot more than band from TWAP refuses; that is
  true for the direction where the edge sits beyond spot. In the other direction nothing refuses.
- **How often.** T5 measured |spot − TWAP| > 100 ticks on WETH/USDC 1.33% of the time (27.6 h over the sample), with
  the longest episode 90 min. During those times the per-crossing loss on that pool is more than twice the band.
- **Example.** An agent's example: cbBTC falls 600 ticks in 30 min. A Safe buy then fills about 4% over the market,
  where the bound says 1.05%.

**Fix.** Use the Safe-favourable side of two TWAPs that cannot be moved inside the block. Take
`ref = max(twapLong, twapShort)` when the Safe sells token0 and `min(...)` when it buys, then
`worst = ref ∓ band`. Moving either TWAP alone can only tighten the bound.

Do **not** use the validation-time `slot0` spot as the reference. The attacker controls ordering before validation
inside its own `handleOps` transaction, so it would push spot first. The agents' suggestion `min(twap, spot) − band`
for zeroForOne also points the wrong way: it loosens the bound. Apply the same reference to `mint`'s spot check. The
liveness cost is close to the mint's current one.

### M-2. token0 and token1 budgets are separate and each sized at the full W_p/T_p, so crossings are about twice the bound (`_spendOk` L417-421; `v4-grants.ts` `v4CapFormulas` budgetWindow0/1, budgetTotal0/1)

**Cause.** `_spendOk` checks `w0 ≤ perWindow0`, `w1 ≤ perWindow1`, `t0 ≤ total0` and `t1 ≤ total1` on their own. The
grant gives each token `capShareBps × multiple`.

**Exploit.**

- **Swaps.** A round trip, token0→token1 (charges total0) then token1→token0 (charges total1), crosses 2T.
- **Mints.** A two-sided mint at both desired caps, followed by an uncharged decrease, crosses 2 × 2T.

So the crossings are about V + 4T, not V + 2T. At the decided parameters the never-revoked bound goes from about 13%
to about 25% of the cap.

**Fix.** Charge one value budget per pool: convert token0 to token1 units at the TWAP tick (the code already calls
`getQuoteAtTick`) and sum. Or halve each per-token budget in `v4CapFormulas` and state the formula per token.

### M-3. Fixed calendar epochs give a leaked key two full windows in two blocks (`_spendOk` L411, L416)

**Cause.** `epoch = block.timestamp / budgetWindow`, and `window0`/`window1` reset at each UTC boundary.

**Exploit.** The key spends `perWindow` at `86400k − 2` and again at `86400k`. That is 2·W within 2 s. For the
stables pool, 2·W = 10C = T, so the whole approval goes in 2 seconds. Every "revoked within d days" figure needs
`(windows + 1)`.

**Fix.** Use a token bucket (refill `perWindow/window` per second) or a two-bucket weighted window. Or keep the
current code and restate the bound. The spec's table also needs recomputing with W = 5/2/3·C (see Summary). All 12
agents raised this item, in all 3 passes.

### M-4. Positions minted outside this deployment can never be admitted (`_isAdmitted` L403-406; the only writer is `mint` L317)

**Cause.** `admittedPool` has exactly one writer, `mint`, on this deployment.

**Effect.**

- **At the v4 renew row.** Every existing position from v2/v3 grants was minted directly at the NPM. After the
  renewal, the engine cannot decrease, collect or burn it. It cannot exit in a crash, harvest, or re-range. The v4
  grant set drops the per-position `manage` grant, and this policy refuses the tokenId. The owner's passkey can
  still exit, so no funds are lost.
- **At an upgrade.** The spec's "Upgrade and rollback" (a new version is a new address) hits the same wall. Every
  position minted through P1 is unadmitted in P2, and the reverse on rollback.

**Fix.** Admit at enable time, owner-signed. Add `uint256[] admit` to `Init`. `initializeWithMultiplexer` then admits
each tokenId after checking `NPM.ownerOf(id) == account` and that the position's (token0, token1, fee) maps to
`i.pool`.

An `admit(tokenId)` callable by the account is a weaker alternative. It is safe today because `checkAction` refuses
its selector, but it is one grant mistake away from session-reachable. Or the rollout must close and re-mint every
position before the renewal. Spec 007 does not say which.

## Low

**L-1. Leaked key drains the Safe's ETH through userOp gas fields (out of contract; `packages/account/sessions` `userOpPolicies`).**

- **Cause.** No paymaster is used, so SmartSession enforces zero userOp policies on gas (`minPolicies = 0`).
  TimeFrame and UsageLimit do not read gas fields.
- **Exploit.** The key signs any valid op, for example `approve(ROUTER, 1)`, with a large `maxPriorityFeePerGas`. It
  then calls `handleOps(ops, beneficiary = attacker)` at a low `tx.gasprice` and receives the account's prefund.
- **Size.** The cost is the 0.002 ETH reserve per account, again after every relayer top-up, across the fleet. The
  engine also stops (`ACCT_GAS_RESERVE_LOW`).
- **Fix.** Add a userOp policy that caps `maxFeePerGas`, `maxPriorityFeePerGas` and the gas limits, or use an
  operator paymaster. The spec's loss formula should name this term.

**L-2. Budget is charged at validation and kept when execution reverts (`checkAction` L246-256, `_spendOk` L422-425).**

- **Key holder.** A key holder burns `T_p` with mints that have no approval, or past deadlines, or swaps with an
  impossible minimum. That stops the engine until renewal, and each attempt also pays gas from the Safe.
- **Third party.** A third party with no key can make an engine op revert after validation by pushing spot about 10
  ticks on stables (about 55k returned capital, about 11 USDC). It needs to see the userOp first, and Base has no
  public mempool.
- **Bundler.** `bundler.ts` simulates with an `eth_call` of `handleOps`. That call does not revert when the inner
  execution reverts, so ops with `success=false` still land and charge the budget.
- **Fix (off chain).** Make the bundler treat `UserOperationEvent.success == false` in the simulation as a refusal,
  keep engine userOps private until they land, and alert on charged spend with no matching execution.

**L-3. ERC-7484: unprivileged `registerModule` (T1 finding).**

- **Consequence 1, front-run.** The first caller picks the module's resolver and metadata, and the registry refuses
  a second registration. An attacker who registers the freshly deployed policy under a resolver that rejects
  `resolveAttestation` blocks every self-attestation, which forces a redeploy. That is liveness only.
- **Consequence 2, no assurance.** Accounts trust only their own attestation, so the registry adds no third-party
  assurance. The owner's signature on `enableSessions` is the only gate. A malicious module registered by anyone
  cannot reach a Mamoru account without that account's own owner-signed attestation, so nothing is exploitable.
- **Fix.** Deploy and register in one transaction (registry `deployModule`/CREATE2 factory). Before any account
  attests, check `findModule(policy).resolverUID` against the expected resolver.

**L-4. USDC/USDT oracle history margin (`_twapTick`).**

- **Margin.** Cardinality is 1,000 and the pool writes at most one observation per block. At 2-s blocks the ring
  holds about 1,998 s against `twapWindow = 1800`.
- **Exploit.** Anyone can fill the ring with one tick-changing dust swap per block. If Base block time drops below
  1.8 s, `observe` reverts `OLD` and the policy refuses everything in that pool.
- **Fix.** Call `increaseObservationCardinalityNext(≥ 4,000)` on the stables pool, and check
  `observationCardinality × minBlockTime ≥ k·twapWindow` at enable.

**L-5. Renewal resets windows and totals (`_spendOk` L413-415).**

A generation change rebuilds `Spend`, so each usage-triggered renewal (one passkey tap) gives a compromised operator,
which also holds the "fresh" key, a new `T_p` and a new same-day window. The spec bound holds per approval, not per
account. Rate-limit renewals, or carry the window spend across generations.

**L-6. Volatile-side budgets are in token units (`initializeWithMultiplexer` L218-224).**

The WETH and cbBTC budgets are fixed in tokens at grant time, so their USD value grows with the price, and so does
the loss bound. The fix in M-2 (value budget in the stable token) removes this.

**L-7. Floored ticks give up to one extra tick (`_swapBounds` L377, `mint` L305).**

`consult` rounds toward −∞ and `slot0.tick` is a floor. A zeroForOne swap (and `min1` in `_decreaseMins`) and a mint
upward can therefore run band + 1 tick from the true mean. On the 10-tick stables band that is up to 10% over. Use
`band − 1` on the loose side, or compare sqrt prices.

## Info

**I-1.** `_poolConfig` and `_budget` are per (account, pool) and last-writer-wins across every action init. Effects:

- **Validation and execution diverge.** `checkAction` uses the per-ConfigId band, while `mint` and the views use the
  last write.
- **Views skip the generation check.** `swapBounds` and `decreaseMins` (L325-346) do not check generation, and
  `decreaseMins` does not check admission.

Today every session of a pool gets the same `Init`, so this costs liveness only. Refuse a same-generation init whose
config differs, or key the account copy by generation.

**I-2.** `Init` is not validated. `twapWindow = 1` makes the TWAP the previous block's tick, `bandTicks` can go up to
887,272, budgets up to uint128, and `generation` up to `type(uint64).max`. The last value bricks every later renewal
on this deployment. All are owner-signed, but the owner taps a hash that the operator built. Add hard bounds
(`twapWindow ≥ 600`, `bandTicks ≤ 500`, `generation ∈ {current, current+1}`). This is defense in depth, because the
same operator could also omit the policy.

**I-3.** Generation retirement holds only inside one deployment. After a migration to a new address, old-address
configs stay valid until `removeSession` runs. The renewal batch must keep `removeSession` for every old
permissionId; spec 007 already requires it for v2/v3.

**I-4.** `removeSession` does not notify the policy. `_poolConfig` keeps `mint` usable by the account (only the
account) until the generation changes. `mint` does not charge the budget itself: any path to `mint` that lacks this
policy on the action (an owner-built grant, a fallback action, another executor) skips the budget. Today none exists.

**I-5.** WETH can be stranded. When the NPM holds ETH, `PeripheryPayments.pay` funds WETH from it, `mint` refunds only
`desired − used` (L314-315), and the pulled WETH stays in the policy, which has no sweep. Anyone can leave ETH in the
NPM. The Safe ends value-neutral (the position is funded by that ETH) and nobody profits. Fix: refund from the
balance delta, or unwrap and return.

**I-6.** Admission is not cleared when the NFT leaves the Safe. If it comes back, the session can manage it again.
The `ownerOf` check covers the time it is away.

**I-7.** The spot check (L303-305) runs before `_pull`/`_approve`. That is fine for USDC, USDT, cbBTC and WETH. With a
hook token, a callback could move spot between the check and `NPM.mint`. Move the check to just before `NPM.mint` if
pools ever widen.

**I-8.** `OracleLibrary` compiled under 0.8 uses checked subtraction on the cumulatives. A wrap would revert, but it
needs about 2^32 s at zero liquidity, so it is unreachable.

**I-9.** `_decreaseMins` rounds down. Tiny `liquidity` gives zero minimums, and the dust per call is worth less than
gas. A spot exactly on the upper edge tick can fail `min0` by one tick, which costs liveness only.

**I-10.** The spec's "Audit surface" says the contract is "about 300 lines". It is 476. The spec table "Max loss with
a leaked key" also uses superseded parameters (see Summary).

## Verified safe

**Theft paths**

- **Pinned recipients.** Swap `recipient == account` (rejects SwapRouter02's `address(1)`/`address(2)` sentinels),
  mint `recipient == account` at validation and execution, and collect `recipient == account` (rejects NPM's
  `address(0)` alias).
- **Approvals.** The target must be the pool's token0 or token1, so the NPM ERC-721 `approve` (same selector) is
  refused. The spender must be `ROUTER` or the policy. Both pull only from `msg.sender`: `_pull(.., account = msg.sender)`,
  and SwapRouter02 `pay` uses `msg.sender` or a payer it encodes itself, behind `CallbackValidation`. Leftover
  allowances are spendable only by the account itself through validated, budget-charged calls.
- **Allowlist.** Every other (target, selector) returns FAILED. That covers direct `NPM.mint` (same selector as the
  policy's `mint`, separated by target), `increaseLiquidity`, `exactInput`, `multicall`, `permit` and
  `increaseAllowance`. `value != 0` is refused.
- **Delegatecall.** Delegatecall is impossible: SmartSession refuses the call type.

**Caller and storage isolation**

- **Callers.** `initializeWithMultiplexer` is SmartSession-only. `checkAction` returns 1 with no write for any other
  caller. SmartSession passes `account = msg.sender = userOp.sender`.
- **Budget charges.** A third party cannot charge another account's budget. A bad session signature makes the
  EntryPoint revert the whole `handleOps` (AA24), which rolls back validation writes.
- **Shared state.** The only cross-account state is `_pool`. It is written only after
  `FACTORY.getPool(token0, token1, fee) == pool`, so it cannot be poisoned. There is no storage collision: everything
  is mappings keyed by account and ConfigId, in a non-proxy contract.
- **Replay.** Replaying an older owner enable signature is impossible (signer nonce). A lower generation reverts
  `StaleGeneration`.

**Mint custody**

- **Flow.** It pulls exactly `desired`, approves the NPM for exactly `desired`, and resets to 0 after (USDT-safe). It
  refunds `desired − used`. `_pull`/`_push`/`_approve` handle tokens that return no value or `false`.
- **Callbacks.** The global lock blocks reentry, and NPM uses `_mint`, not `_safeMint`, so there is no
  `onERC721Received` callback.
- **Token order.** Unsorted tokens revert in `PoolAddress.computeAddress`. `checkAction` also requires the exact
  pool tokens and fee.
- **Third-party mints.** A third party can mint only for itself. Its own malicious-token pool touches only its own
  mappings and cannot reach the policy's balances (the allowance equals its own pull).

**Admission**

- **TokenIds.** NPM tokenIds are monotonic and never reused, so burn and re-mint cannot collide.
- **Sent positions.** Positions sent to the Safe by others are never admitted.
- **Burn.** A burned tokenId makes `ownerOf` revert, so it is refused. `burn` cannot destroy value: NPM requires
  zero liquidity and zero owed tokens.
- **Pool binding.** Admission is bound to the pool, and decrease, collect and burn require `admittedPool == c.pool`.

**Price math**

- **Swaps.** `getQuoteAtTick` direction and `minOut = quote × (1e6 − fee)/1e6` are correct for both directions. The
  limit direction is correct: a floor for zeroForOne, a ceiling otherwise. A partial fill at the limit fails the
  full-amount `minOut` and reverts. `amountIn == 0` (SwapRouter02 CONTRACT_BALANCE) spends only the router's own
  balance.
- **Same-block TWAP.** It cannot move: the pool writes `slot0Start.tick` at the first tick change of a block, so
  validation and execution see the same TWAP. The spec's "no time-of-check gap" claim holds.
- **Decreases at a pushed spot.** They cannot lose value at the reference price. LP holdings valued at p_ref are
  smallest when spot equals p_ref (dV/dp = x′(p)(p_ref − p)). The edge minimums are a liveness guard. The spec's
  narrow-range claim holds.
- **Mint ranges.** Any tick range is bounded by the spot check. Ranges away from spot fill only at prices
  favourable to the Safe.
- **Overflow.** `_absDiff` stays at most 1,774,544 < 2^24. `_add`/`_sub` clamp. The `_spendOk` sums are checked and
  the `uint128` casts come after the cap compare. `_u128` guards the quote. The 0.8 library ports (`FullMath`,
  `TickMath` unchecked blocks, `LiquidityAmounts`) match upstream.

**Budgets, generation, interfaces**

- **Spend.** Spend is charged call by call across a batch. Validation of all ops precedes execution, so a decrease of
  a tokenId minted in the same bundle is refused, which costs liveness only. The epoch and generation resets behave
  as coded (see M-3, L-5).
- **Retirement.** A higher generation retires every lower config of the account in this deployment, in both
  `checkAction` and `mint`.
- **Interfaces.** `supportsInterface` exposes only the action-policy ids, so the policy cannot be enabled as a userOp
  or ERC-1271 policy. The v4 sessions enable no ERC-1271/7739 policies, so a key cannot sign permits.

## Recommendation for T7

Do not deploy until these are done:

- **H-2.** Make the integration fail closed, plus the test.
- **M-4.** Add owner-signed admission at enable, or an explicit close/re-mint plan.
- **H-1.** Measure on fork. If confirmed, add the short-TWAP/harmonic-liquidity check, which also gives most of the
  M-1 fix.
- **M-2 and M-3.** Fix the budget code, or restate the bound, and recompute spec 007's loss table with the decided
  parameters.
- **L-1 and L-2.** Add the gas-cap userOp policy and the bundler `success` check. Neither needs a contract change.

A second, independent review (Codex GPT-6 per the xreview policy for fund-guarding code) of the patched contract is
still advisable.
