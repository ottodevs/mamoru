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

| Approval | Prompts | Used | Estimate | Operator limit |
|---|---|---|---|---|
| v7 activation (attests V2, gas policy, gate) | 1 | 12.05M | 12.86M | 13.14M |
| v7 renewal (4 revoked) | 1 | 11.59M | 13.48M | 13.82M |
| move v6 (8 sessions) -> v7 | 1 | 11.87M | 14.63M | 15.07M |
| move v5 (9 sessions) -> v7 (+ gate attest) | 1 | 12.05M | 15.14M | 15.63M |
| move legacy v2 (12 sessions) -> v7 (+ 3 attests) | 1 | 12.69M | 15.57M | 16.08M |
| today: v5 activation | 2 | 13.29M + 12.83M | | |
| today: v6 activation | 2 | 13.27M + 9.17M | | |

The due diligence's 11.3-11.75M are receipt figures. Each `removeSession` is ~0.3M before its refund, so a move's gas
LIMIT is 3-4M above its receipt. Against V4_TX_GAS_TARGET (14.5M) the v5 and v2 moves would be refused; the operator bounds
a one-transaction approval by its gas budget instead (RENEW_GAS_BUDGET 16.2M, ACTIVATION_GAS_BUDGET 15M) and refuses above
it (RENEWAL_TOO_LARGE), never splits. The legacy v2 move leaves ~1.2M to Base's 2^24 by estimate; an account with more
than ~13 sessions to revoke does not fit.

## Security: what the merge drops and what still enforces it

Pinned rule by rule in `packages/policy/src/v7.test.ts`; each refused on the fork by V2 at validation (t11 section 5).

| Dropped / loosened UniActionPolicy rule | Enforced by | t11 attack (refused) |
|---|---|---|
| swap tokenIn / tokenOut (direction) | V2 `_checkSwap`: only the pool's two tokens, fee, recipient, spot in band, minOut and price limit from the band, budget charged both ways | USDC -> cbBTC through the WETH/USDC session; loose minimum / no limit both directions; manipulated spot |
| approve spender | V2 APPROVE: only SwapRouter02 or V2 itself, only the pool's tokens | approve to the attacker; approve to the NonfungiblePositionManager |
| approve amount | kept, larger of the merged per-call caps (`cap:a\|b`) | |
| swap amountIn per call | kept, larger cap across units (loose for WETH); V2's per-window budget binds | three swaps over the window in one op |
| cumulative totals (swap, mint, convert) | V2 per-pool budget: `perWindow` (refills over a day, carries across generations) and `total` per generation | batch over budget |
| mint amount0Min / amount1Min > 0 | V2 `_checkProvide` (spot in band, minimums met at spot) and the spot check right before the manager's mint; v6's manage-any mint never had them | mint paid to the attacker |
| decrease / collect / burn rules (tokenId > 0, recipient) — V2 alone | V2: admitted position the Safe owns, collect recipient = the Safe, decrease minimums from the band (stricter than before) | collect to the attacker; decrease with zero minimums; decrease / burn / increase of an unadmitted position |
| swap deadline rules — V2 alone | V2: the exact empty `multicall(deadline, [])` encoding | `multicall(deadline, [swap to the attacker])` |

Unchanged: one session key for the whole set (as today); MamoruGasPolicy caps (refused over cap); guardian pause; the exit
pool keeps its cbBTC -> USDC rule (buying cbBTC or minting there is not granted); bridge-out is v6's grant byte for byte.
Revocation and renewal stay per approval. Usage: a key can now spend a pool's 36,000 uses on any of its actions; the
total across sessions is v6's, and value is bounded by V2's budget, not by usage.

## Not verified

- Monad (its own prompt, out of scope); the real browser authenticator; the L1 data fee of the larger calldata.
- MamoruPauseGate is `undeployed` in the registry: a signing operator refuses v7 (like v6) until it is pinned.
