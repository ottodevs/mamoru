# One owner transaction per approval: conservador-live-v7 (otto/mamoru#225, 2026-10-27)

Branch `feat/225-merged-grants`, stacked on #141 (v6). Design from `enable-mode-dd-2026-10-27.md` (recommendation 1, "pool3"):
each pool's enter-swap, enter-mint and manage-any merged into ONE session by (target, selector); the whole approval is one
ordinary owner Safe transaction. No ENABLE mode, no gas-cap change, same session key, same contracts
(MamoruActionPolicyV2, MamoruGasPolicy, MamoruPauseGate). Fork run: `packages/scenarios/action-policy/t11-merged-grants-fork.ts`
(Base block 51,811,000, every owner transaction passkey-signed). Operator run: `apps/mamoru-operator/test/e2e-v7.ts`.

## Shape

| | v6 | v7 |
|---|---|---|
| Sessions | 8 (3 + 3 + exit-only + bridge-out) | 4 (stables, Balance, USDC/cbBTC exit-only, bridge-out) |
| Actions / with UniActionPolicy (pools) | 38 / 36 | 26 / 12 (+2 bridge-out) |
| Usage limit per pool session | 3,000 + 1,000 + 32,000 | 36,000 (the sum); exit 32,000; bridge 64 |
| Owner transactions per approval | 2 (activation), 2+ (moves, renewals) | 1, always (`session.oneTransaction`) |

`grantKeyFor(policy, role, pool)` resolves enter-swap / enter-mint / manage-any of a pool to its one session
(`GrantTemplate.covers`), so the engine's proposals and `anyKey` are unchanged.

## Gas (t11, receipt gas used / eth_estimateGas + passkey check / the operator's ownerTxGasLimit)

Re-measured after the review's P1-2 with realistic admissions: each moved account holds positions, admitted in the move's
Init as the operator's v4Context does, and a legacy account also revokes the per-position `manage` grant of each one.

| Approval | Prompts | Used | Estimate | Operator limit |
|---|---|---|---|---|
| v7 activation (attests V2, gas policy, gate) | 1 | 11.96M | 12.76M | 13.03M |
| v7 renewal (4 revoked) | 1 | 11.50M | 13.38M | 13.71M |
| move v6 (8 sessions, 1 position admitted) -> v7 | 1 | 11.77M | 14.53M | 14.95M |
| move v5 (9 sessions) -> v7 (+ gate attest) | 1 | 11.95M | 15.04M | 15.52M |
| move v5 (9 sessions, 2 positions admitted) -> v7 | 1 | 12.17M | 15.27M | 15.76M |
| move legacy v2 (12 sessions) -> v7 (+ 3 attests) | 1 | 12.59M | 15.47M | 15.97M |
| move legacy v2 (12 + 1 manage, 1 position) -> v7 | refused | (12.78M) | 15.88M | **16.42M** > 16.2M |
| move legacy v2 (12 + 2 manage, 2 positions) -> v7 | refused | (12.96M) | 16.30M | **16.86M** > 2^24 |
| -> its fallback, the v6 move (as today) | 2 | 10.07M + 13.21M | 13.28M + 13.87M | 13.67M + 14.22M |
| today: v5 activation | 2 | 13.29M + 12.83M | | |
| today: v6 activation | 2 | 13.27M + 9.17M | | |

Each `removeSession` is ~0.3M before its refund, so a move's gas LIMIT is 3-4M above its receipt. The operator bounds a
one-transaction approval by its gas budget (RENEW_GAS_BUDGET 16.2M, ACTIVATION_GAS_BUDGET 15M), not V4_TX_GAS_TARGET
(14.5M). An admitted position adds ~0.12M to the limit; a per-position grant to revoke ~0.45M. A legacy v2 account with
even one per-position grant does not fit (the second case is over Base's 2^24 itself), so a v7 move is never guaranteed.

What the operator does then (review P1-2): `planRenewOrFallBack` catches RENEWAL_TOO_LARGE on a v7 move, marks the
account's grant set (`oneTxRefused`) and plans the renewal again for the target it would have had without v7: the v6 move
(t11 sends it: 2 prompts, 14 revoked in the first), the v5 move, or the account's own renewal for a v6 account. While the
set holds, `v4Target`/`renewTarget` and the renew row say the fallback, so what is signed is what the row shows; once the
set changes (the fallback landed) v7 is offered again, now from v6 (8 revokes, fits). A v7 Start over 15M activates v6
instead. The refusal by the static estimate (no in-Safe simulation: 26 x 590k + 190k per revoke + overheads, ~16.5M for a
fresh Start and ~18M for a move, both of which fit when simulated) takes the same fallback, so it costs prompts, never a
stuck account. A v7 account's own renewal (13.7M) has no other target and stays refused if it ever grows over 16.2M.

## Security: what the merge drops and what still enforces it

Pinned rule by rule in `packages/policy/src/v7.test.ts`; each refused on the fork by V2 at validation (t11 section 5).

| Dropped / loosened UniActionPolicy rule | Enforced by | t11 attack (refused) |
|---|---|---|
| swap tokenIn / tokenOut (direction) | V2 `_checkSwap`: only the pool's two tokens, fee, recipient, spot in band, minOut and price limit from the band, budget charged both ways | USDC -> cbBTC through the WETH/USDC session; loose minimum / no limit both directions; manipulated spot |
| approve spender | V2 APPROVE: only SwapRouter02 or V2 itself, only the pool's tokens | approve to the attacker; approve to the NonfungiblePositionManager |
| approve amount | kept, the larger of the merged per-call caps (`cap:a\|b`): every cap merged there counts the approved token itself | |
| swap amountIn per call | dropped (see below): enter-swap capped it in the stable token, the harvest in the volatile one, and raw amounts of two tokens are not comparable. V2's per-window budget is the per-call bound | three swaps over the window in one op |
| cumulative totals (swap, mint, convert) | V2 per-pool budget: `perWindow` (refills over a day, carries across generations) and `total` per generation | batch over budget |
| mint amount0Min / amount1Min > 0 | V2 `_checkProvide` (spot in band, minimums met at spot) and the spot check right before the manager's mint; v6's manage-any mint never had them | mint paid to the attacker |
| decrease / collect / burn rules (tokenId > 0, recipient) — V2 alone | V2: admitted position the Safe owns, collect recipient = the Safe, decrease minimums from the band (stricter than before) | collect to the attacker; decrease with zero minimums; decrease / burn / increase of an unadmitted position |
| swap deadline rules — V2 alone | V2: the exact empty `multicall(deadline, [])` encoding | `multicall(deadline, [swap to the attacker])` |

### Per-call amount caps after the merge

`mergeRules` merges a LESS_THAN_OR_EQUAL amount cap only when every merged rule counts the same token (`amountToken`:
an approve's amount is the approved token; a swap's amountIn its pinned `tokenIn`; a mint's amount0/1Desired its pinned
`token0`/`token1`). Otherwise the rule is dropped. Taking the larger raw number across tokens would have kept a WETH cap
(~3e17 for 0.3 WETH) as the bound on USDC-in swaps (1e9 for 1,000 USDC): no bound at all.

Per-call caps that remain on a v7 pool session (stables and Balance; the exit pool keeps v6's exit-only rules as they were):

- stable approve: the larger of the swap and mint caps (both in the stable token);
- volatile approve: the larger of the mint and convert caps (both in the volatile token);
- mint amount0Desired / amount1Desired: the mint caps, unchanged (both grants pinned the same tokens);
- increase amount0Desired / amount1Desired: the mint caps (manage-any's only).

The swap's amountIn has no UniActionPolicy cap in either direction. Its per-call bound is MamoruActionPolicyV2's
`_checkSwap` -> `_charge`: every swap, stable-in or volatile-in, is valued in the stable token at the band edge and refused
when the pool's bucket (`perWindow` = capShare x windowMultiple, 2x the Balance share, 5x the stables share) or the
generation's `total` would be exceeded; minOut and the price limit come from the band, and the Init refuses a pool
whose in-range depth does not cover `perWindow`. So one swap moves at most one window's budget at a band-edge price,
where v6 needed `perWindow / riskSwapPerCall` calls (two on Balance) to spend the same. That is the loss: a per-call layer,
not the economic bound, which V2 held in v6 too. In practice a stable-in swap is also bounded by the router allowance
the same session can set (the stable approve, at most the mint cap, 2x the share), unless the owner granted the router
more themselves.

The dropped cumulative totals are covered by V2's `total`: `riskSwapTotal` and `riskConvertTotal` (and the mint totals)
are each capShare x totalMultiple, the same T_p as the pool's `budgetTotal`, and V2 charges swaps in both directions and
mints against that one `total`, so their sum is held to what each was alone. The signed summary (`v7Lines`) names only
the per-day and total budget per pool, no per-swap cap, so it claims nothing that no longer exists.

Unchanged: one session key for the whole set (as today); MamoruGasPolicy caps (refused over cap); guardian pause; the exit
pool keeps its cbBTC -> USDC rule (buying cbBTC or minting there is not granted); bridge-out is v6's grant byte for byte.
Revocation and renewal stay per approval. Usage: a key can now spend a pool's 36,000 uses on any of its actions; the
total across sessions is v6's, and value is bounded by V2's budget, not by usage.

## Not verified

- Monad (its own prompt, out of scope); the real browser authenticator; the L1 data fee of the larger calldata.
- MamoruPauseGate is `undeployed` in the registry: a signing operator refuses v7 (like v6) until it is pinned.
