# What a leaked session key can lose

Threat model for the public leaked-key bounty (`otto/mamoru#93`). Nothing is published from this page: the bounty needs a review by a second model and Ot's GO.

The setup is one Mamoru account on Base with a 25 USDC cap. Its engine session key is public, so anyone can sign user operations with it. The chain still checks every one of them against the account's session policy.

## The claim we can make

**"This key cannot send your money to anyone else."** Do not say "you cannot lose anything" or "the key is harmless". As shown below, the key can still lose value inside the account.

The claim rests on these fork scenarios:

| Attempt | Scenario | Refused with |
|---|---|---|
| Transfer the tokens out | SESS-04 | `POLICY_DENIED_TARGET` |
| Swap with another recipient | SESS-01 | `POLICY_DENIED_RECIPIENT` |
| Approve an attacker or Permit2, sweep the router | SESS-07, SESS-08, SESS-22 | `POLICY_DENIED_APPROVAL` / `POLICY_DENIED_TARGET` |
| Add an owner, install a module, set a guard, delegatecall | SESS-14, SESS-15, SESS-16, SESS-23 | `POLICY_DENIED_TARGET` |

The key also cannot sign for the account: there is no ERC-1271 policy (`packages/account/sessions/index.ts`). It cannot reach a paymaster or the relayer subsidy either. Sessions have `permitERC4337Paymaster: false` (`packages/policy/src/instantiate.ts`), so the Safe pays its own gas.

## What it can lose: the sandwich

The key holder controls the account's swaps, and it also controls its own capital. In one transaction it can:

1. push the pool with its own capital,
2. make the account swap through the session at the pushed price,
3. push the pool back.

Every token stays in the account, but the account trades at a bad price. How bad depends on the policy:

- **v2** (`conservador-live-v2`, the operator's default policy) is UniActionPolicy only. A swap needs `amountOutMinimum > 0`, and the price limit must be 0 (`packages/policy/src/grants.ts`). The fee tier is pinned to the granted pool. Mints under `manage-any` have no minimums.
- **v6** (`conservador-live-v6`) adds MamoruActionPolicyV3. A swap must carry the minimum and the price limit of a 30-min / 5-min TWAP band, and the spot must be inside the band at validation (spec 007).

### Measured

`contracts/action-policy/test/LeakedKeyLoss.t.sol` runs on a Base fork at block 52,700,000:

```
forge test --mc LeakedKeyLoss -vv
```

Swap sizes are the v2 per-call caps at C = 25: 12.5 USDC for stables, 10 for cbBTC, 5 for WETH. Each loss is measured against the 30-min TWAP quote, so it includes the pool fee. "Attacker net" is what the push and the push back cost the attacker in USDC.

**v2: the swap the key signs with minOut 1.**

| Pool | Push | Account loss | Attacker net |
|---|---|---|---|
| USDC/USDT 0.01% | 100 ticks | 1.0% | -23.8 USDC |
| | 10,000 ticks | 63% | -17.4 USDC |
| USDC/cbBTC 0.05% | 10,000 ticks | 63% | -4,366 USDC |
| WETH/USDC 0.3% | 10,000 ticks | 63% | -575,219 USDC |

A deeper push takes the swap close to 100%. Nothing on chain bounds the loss below the amount.

On these pools the sandwich does not pay for itself. The attacker spends more than the account loses, so this is griefing, not theft. The cheapest route is the stables pool: about 17 USDC of the attacker's money to wipe one 12.5 USDC swap.

**v6: the spot parked one tick inside the band edge.** This is the worst price V3 admits. One tick further and validation refuses the swap.

| Pool | No push (churn at spot) | At the band edge | Attacker net per push |
|---|---|---|---|
| USDC/USDT 0.01% | 0.00% | 0.08% | -9.3 USDC |
| USDC/cbBTC 0.05% | 0.08% | 1.03% | -360 USDC |
| WETH/USDC 0.3% | 0.42% | 1.28% | -43,365 USDC |

V3 refuses the minOut 1 swap that v2 accepts. It also refuses a push one tick past the edge.

### Bound at C = 25 for v6

Spec 007 bounds the volume a key can make the account swap per pool: `V_p + 2 x min(T_p, W_p x (1 + tau / 1 day))`. The v6 budgets at C = 25 come from `packages/policy/src/policies-v6.ts`:

- stables: V 12.5, W 62.5, T 125;
- WETH/USDC: V 8.75, W 17.5, T 87.5.

cbBTC is exit-only in v6.

| Session revoked | Free (churn at spot) | Paid (spot at the edge) |
|---|---|---|
| within 1 day | 0.35 USDC | 1.25 USDC |
| never | 0.80 USDC | 2.6 USDC |

Add 1.03% of any cbBTC the account still holds; at most 10 USDC of cbBTC gives 0.10.

To get the paid column through WETH/USDC, the attacker spends about 43k USDC per push. The rational worst case is therefore the free column, plus a few cents through the stables.

### Gas

The Safe pays its own gas from a reserve of 0.0005 ETH, about 1.35 USD (`docs/gas-reserve.md`):

- **v2:** no gas policy. A key holder who submits its own user operation can set any fee and spend the whole reserve in one operation.
- **v6:** MamoruGasPolicy caps one operation at 5.2e14 wei. That is about the whole reserve, so the result is the same.
- `MamoruGasPolicyV2` adds a daily bucket, but it is not deployed.

Count the whole reserve as lost in both policies.

## Worst case and verdict

| Policy | Worst case at C = 25 | Bounty |
|---|---|---|
| v2 | The whole account (~25 USDC) plus ~1.35 USD of gas. Griefing at a cost to the attacker of about 2 to 3 times the loss, measured through the stables. | **No-go** |
| v6 | Rational, never revoked: ~0.8 USDC + 1.35 USD of gas, about 9% of 25. Paid, never revoked: ~2.7 USDC + 1.35 USD, about 16%, for an attacker who spends tens of thousands of USDC. | Go, after review and Ot's GO, on a v6 account only |

The v2 row is not specific to the bounty. Any account still on v2 has the same bound if the operator's key leaks. Spec 007 and V3 exist to fix that.

## What the user sees today

Nothing specific. SESS-24 (`SESSION_FOREIGN_USE`: alert, pause, "Revoke Mamoru now") is specified in `specs/001-mamoru-v1/scenarios.md` but is not in the catalog. The guardian watches only V4 registrations.

Two signals show indirectly:

- the session usage counter rises, and the renewal prompt fires at 80%;
- the low gas reserve alert fires.

A public bounty account needs SESS-24, or at least a note on the page that the account is expected to be griefed.

## Not covered here

- **v2 mints and decreases without minimums.** Same mechanism as the swap; not measured.
- **TWAP manipulation held across block boundaries**, which moves the band itself. Spec 007 measures it at about 10M USDC of own capital for cbBTC; the stables anchor clips it.
- **The Monad Safe.** If it shares the session key, bridge-out can move up to 50% of C, always to the account's own Safe.
- **Which live accounts run v2 and which run v6.** D1 `accounts.policy_version` does not tell them apart.
- **The block.** These numbers are for block 52,700,000. Pool depth changes, so rerun the test before publishing anything.
