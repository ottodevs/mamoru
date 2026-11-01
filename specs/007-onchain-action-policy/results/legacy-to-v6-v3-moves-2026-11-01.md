# Legacy v2/v3/v4 (and v5) → v6-on-V3 moves: gas, owner transactions, stuck cases (otto/mamoru#254)

Measurement only. No grant, policy, contract or v6/remote code changed. Base fork at block 51,811,000 (the lab manifest), main
`986c0afd` (PR #172: v6 on MamoruActionPolicyV3 alone, one manage-any per pool). Harness:
`packages/scenarios/action-policy/t12-legacy-to-v6-v3-moves.ts` (built on t9 and on the #166 t11 harness; same builders as the
operator: `instantiateGrant`, `retargetToPolicy`, `v4PoliciesFor`, `activationBatch`, `revocationCalls`, `orderV4Keys`,
`fitPrefixBySimulation`, `remoteSafe(remoteInput(..))`; every owner transaction signed by the passkey).

## What was measured, and the two thresholds

v6 on V3 is 4 sessions / 26 actions (manage-any stables 9, WETH/USDC 9, cbBTC 6, bridge-out 2). Each account state is measured two ways:

- **One transaction:** revokes + attests + the 4 v6 sessions + Init.admit in a single owner tx, sent with gas limit 2^24 - 1. Reported: `gasUsed`, the operator's gas limit for it
  (`ownerTxGasLimit` = `simulateAndRevert` gas × 9/8 + 300k passkey check) and `eth_estimateGas` + 300k.
- **As planRenew splits it today:** `planRenew` → `fitV4` takes the longest prefix of whole sessions whose operator limit is ≤ `min(RENEW_GAS_BUDGET, V4_TX_GAS_TARGET)`
  = `min(16.2M, 14.5M)` = **14.5M**; revokes ride in the first tx; the rest become `planExtend` txs. Each tx is one passkey prompt.

The 16.2M the ticket names is `RENEW_GAS_BUDGET`. For a v4/v5/v6 approval it does not bind: `fitV4` clamps it to `V4_TX_GAS_TARGET` 14.5M. A v6 move is not a
`oneTransaction` policy (that was v7 in #166), so there is no 16.2M one-tx path on main. The operator's limit also over-states the real gas: `simulateAndRevert` shows no
refund for the cleared revoke slots, so it runs 3.2M to 3.7M above `gasUsed` for the small accounts and about 7.5M above for the 22-position one.

## Results

V3 deployed at the pinned address 0xDD2E387B748420C6501EC96Ec48F87cDEdf16749 (see "V3 on the fork"). All figures gas; "limit" = operator limit.

| Account before the move | Revoked | Admitted | One tx: gasUsed | One tx: limit | ≤ 14.5M | Owner txs (prompts) as planned today | Gas per tx (gasUsed) |
|---|---|---|---|---|---|---|---|
| v5 on V2, 2 engine positions (sanity vs 10.68M) | 9 | 2 | 10,704,528 | 14,294,120 | yes (206k spare) | 1 | 10.70M |
| v5 on V2, no positions | 9 | 0 | 10,504,210 | 14,073,289 | yes | 1 | 10.50M |
| v4 on V1, 2 engine positions | 9 | 2 | 10,628,109 | 13,867,948 | yes | 1 | 10.63M |
| v4 on V1, no positions | 9 | 0 | 10,427,779 | 13,647,118 | yes | 1 | 10.43M |
| v2/v3 legacy, 12 sessions, no positions | 12 | 0 | 10,666,717 | 13,990,874 | yes | 1 | 10.67M |
| v2/v3 legacy + 1 per-position manage, 1 position | 13 | 1 | 10,851,864 | 14,438,254 | yes (**62k spare**) | 1 | 10.85M |
| v2/v3 legacy + 2 per-position manage, 2 positions | 14 | 2 | 11,033,766 | 14,881,957 | **no** | **2** | 9.62M (3 sessions) + 1.58M (bridge-out) = 11.20M |
| v2/v3 legacy + 6 manage, 6 positions | 18 | 6 | 12,027,911 | 16,635,439 | no (also > 16.2M) | **2** | 8.28M (2 sessions) + 4.84M (2) = 13.13M |
| v2/v3 legacy + 12 manage, 12 positions | 24 | 12 | **reverted: out of gas at 2^24-1** (16.14M used) | 19,266,011 | no | **2** | 10.17M (2) + 4.84M (2) = 15.01M |
| v2/v3 legacy + 16 manage, 16 positions | 28 | 16 | reverted (16.16M used) | 21,019,782 | no | **2** | 9.00M (1 session) + 7.91M (3) = 16.90M |
| v2/v3 legacy + 20 manage, 20 positions | 32 | 20 | reverted (16.18M used) | 22,773,406 | no | **2** | 10.09M (1) + 8.12M (3) = 18.20M |
| v2/v3 legacy + 22 manage, 22 positions | 34 | 22 | reverted (16.19M used) | 23,650,702 | no | **none: RENEWAL_TOO_LARGE (HTTP 409)** | nothing sent |
| v2/v3 legacy + 24 manage, 24 positions | 36 | 24 | reverted (16.20M used) | 24,527,593 | no | **none: RENEWAL_TOO_LARGE** | nothing sent |

Columns for the first seven rows, `eth_estimateGas` + passkey: 13.74M, 13.53M, 13.35M, 13.14M, 13.46M, 13.88M, 14.29M. Every row that landed did so with gas limit 2^24 - 1 and
passed the post-checks (old permissions all disabled, 4 of 4 v6 permissions enabled, `V3.generationOf` = prior + 1, every admitted position resolves to its pool in
`V3.admittedPool`). v4 on V1 at generation 1 moves to V3 at generation 2 (V2 → V3 the same); v2/v3 start at generation 1. The jump rule (first enable at V3 may jump up to 65,535) is not a constraint here.

Slope: each legacy position that carries its own `manage` grant adds about 0.44M to the operator limit (one more revoke plus one more Init.admit) and about 0.18M to `gasUsed`.

Gas limit sent: the one-tx figures above were sent with 2^24 - 1 = 16,777,215. The split txs were sent the same way; their "limit" column in the JSON report is the operator's figure for that prefix.

## Which versions need more than one prompt

- **v5, v4 and v2/v3 without per-position grants: one prompt**, with or without the two engine positions admitted. The binding number is the operator's limit (13.6M to 14.3M against 14.5M), not the chain (10.4M to 10.7M used).
- **v2/v3 legacy with per-position `manage` grants:** one prompt up to 1 position with its grant (62k below the target); **two prompts from 2 positions upward**, up to 20. The chain itself would still take the 2-position move in one tx (11.03M used); the second prompt comes from the operator's estimate. From about 12 positions the one-tx move truly does not fit 2^24 (it runs out of gas).
- v3: there is no `conservador-live-v3` policy object in the code (the name appears only in the operator's `V4_MIGRATES_FROM`/`V5_MIGRATES_FROM` sets and in spec 004). It is measured as v2 (same 12-session on-chain grant set). If production v3 accounts hold a different set, this row does not cover them.

How the two prompts split (`orderV4Keys`, preference order): with 2 to 12 positions, prompt 1 = manage-any of the 2 or 3 pools, prompt 2 = bridge-out (or cbBTC manage-any + bridge-out). With 16 to 20 positions prompt 1 = stables manage-any only (9 actions), prompt 2 = WETH/USDC + cbBTC + bridge-out.

## Stuck or degraded cases

1. **Too many legacy positions: the move is refused and the account cannot renew either.** Between 20 and 22 positions with a per-position grant each (32 to 34 revokes), not even one v6 session fits 14.5M with the revokes: `fitV4` throws `RENEWAL_TOO_LARGE`, nothing is sent, the legacy sessions stay enabled and the engine keeps running. But `planRenew` builds `target ?? policyOf(acc)` (read from the code, not run): while `v4Target` returns v6 for the account (it is in the `multichain_v6` scope), the renew row can only offer the v6 move, so the legacy grants cannot be renewed when they lapse. The revokes cannot be split from the first session enable; only taking the account out of scope or an owner Stop (`planRevokeOnly`, not exercised here) gets out. How many positions production accounts hold was not checked here; this is the bound.
2. **Between prompt 1 and prompt 2 the account runs on part of v6.** Prompt 1 revokes every old session and enables a prefix; the positions of a pool whose manage-any is in prompt 2 have no session until it lands (the engine cannot decrease or collect there; the operator's step text says "until then Mamoru does not act there"). With 16 to 20 positions only the stables pool is covered after prompt 1. The Monad leg (bridge-out) is always in prompt 2 for the 2-prompt cases. Nothing is lost on chain: positions and tokens stay in the Safe; an owner who stops after prompt 1 has a working but partial v6 (V3 generation already bumped, so no old session can come back).
3. **Thin margin at 1 position (62k).** The split decision is taken at prepare time by simulation; state drift between prepare and landing cannot make a landed tx fail (it uses ≤ 11M of 16.78M), it can only change the prompt count at the next prepare.
4. No stuck case found for v4 or v5 (with or without admitted positions) and no case where gas, generation, attestation or Init.admit made a landed tx revert in the operator's split path.

## V3 on the fork

`DeployV3.s.sol` `run()` could not run as written: it requires `block.chainid` 8453 or 143 and the lab fork reports 31337. What was done instead: the script's own `deploy` call, `ModuleRegistry.deployModule(salt = PINNED_DEPLOYER ++ nonce 4, resolverUID, creationCode ++ argsFor(8453) with PINNED_GUARDIAN)`, sent by the pinned deployer 0x8F7D5E4F206a91c58132b8f88c629b45d8dcb5A0 impersonated by the local anvil (no key). The contract landed at the pinned address 0xDD2E387B748420C6501EC96Ec48F87cDEdf16749 (CREATE2 depends only on registry, salt and init-code hash, so the address equality shows the init code hash is the pinned one), 24,336 bytes, 5.93M gas, ModuleRecord under Mamoru's resolver. Nothing was etched. MamoruPauseGate(SMART_SESSION, V3) went through `deployModule` from a dev account (DeployPauseGate.s.sol pins the production deployer). V1, MamoruGasPolicy and V2 come from Deploy.s.sol / DeployV2.s.sol as in t8/t9.

## Method notes and limits

- Anvil is the pinned 1.7.1 from `~/.foundry/bin` (the nix foundry gives 1.7.1-dev, which the lab refuses). Put it first on PATH.
- Positions: v4/v5 accounts hold the engine's WETH/USDC and USDC/cbBTC positions minted through their own policy contract (V1 or V2 `mint`); legacy accounts hold owner-minted WETH/USDC and USDC/USDT positions (the legacy engine's mints are plain NPM mints to the Safe), each with a per-position `manage` grant enabled after its mint, as t11. The stress rows split positions half in WETH/USDC and half in USDC/USDT.
- Sessions of v4/v5 are enabled as the operator splits them today; legacy v2 sessions four at a time.
- One account, one key, 1,000 USDC cap, as t7 to t11. The figures are for that fork block; the revoke cost depends on the sessions' storage, the admit cost on the number of positions per pool Init.
- Not measured: v3 accounts with a grant set different from v2; Stop on an account in scope; the app-side flow after prompt 1; the Monad side of the remote Safe.

## Run

```
PATH="$HOME/.foundry/bin:$PATH" bash -c '
  cd contracts/action-policy && ./install.sh && forge build --silent && cd ../.. &&
  bun packages/scenarios/action-policy/t12-legacy-to-v6-v3-moves.ts'          # the seven main rows, ~33 min (public RPC)
T12_STRESS=<N> bun packages/scenarios/action-policy/t12-legacy-to-v6-v3-moves.ts   # legacy v2/v3 with N positions + N manage grants
```

Exit codes on 2026-11-01: main run 0; stress N = 6, 12, 16, 20, 22, 24 all 0; `bun run typecheck` 0.
