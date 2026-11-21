# 014: Every account on the Base-only policy; Monad money home, placed in USDC/cbBTC

Ticket: otto/mamoru#428 (milestone "Feedback Monad"). Related: #415 (entry pause, live), #427 (unwind to USDC on Monad,
no signature), spec 002 (multichain), spec 010 (one authorization, the two-step "What's new" flow this reuses).
Status: draft r1, 21 Nov 2026.

## Decision (owner, 21 Nov 2026)

- No new capital goes to Monad until further notice. `entryPause` for chain 143 is live in the engine settings, until
  4102444800.
- Every Monad growth position is closed and its WMON sold to USDC, held on the Monad Safe (#427, existing V3 grants, no
  signature).
- Each Monad user is then asked for one authorization that brings that USDC back to their Base Safe and puts it into
  USDC/cbBTC.
- **Scope addition (owner, 21 Nov):** every account, new and old, ends on the newest policy version wherever possible.
  - The Base-only policy (`conservador-live-v8`, below) is the default for every new Start.
  - Every existing Base account (v2-v7) is offered the same one-signature upgrade to it.
  - A Monad account also signs the Monad leg (CCTP back to Base and session revoke). That is a second passkey prompt,
    not the same signature: one assertion cannot cover two chains on these Safes (next section).

## State on 21 Nov 2026 (read in code at 66f881d1)

- **Monad Safe authority.** A v6/v7 account's Safe on Monad carries one V3 session (`liveWmonUsdcMonadV6`,
  `packages/policy/src/policies-monad.ts:75`, grant `manageAnyV3Only(V4_POOLS_MONAD.growth)`). The session can decrease,
  collect, burn, mint and increase on the growth pool, and swap WMON for USDC. It cannot bridge or transfer. A return
  to Base on V3 is logged as `noteReturnBlocked` (`apps/mamoru-operator/src/operator.ts:6536`). Only V4 can return,
  and V4 is off.
- **USDC/cbBTC on v6/v7 is exit only.** The bucket is at preference 0 and its grant is `exitOnlyV5Grant`, which has no
  mint, no increase and no USDC approval (`policies-v6.ts:40`, `policies-v7.ts:41`). The allocation is part of the
  signed policy, and its hash salts the session ids. So putting money into cbBTC again is a new approval.
- **One passkey prompt covers one chain** (spec 010, "Limit"). The passkey signs a Safe tx hash, and that hash's
  EIP-712 domain holds the chain id and the Safe. A signature valid on both chains would need a chain-agnostic
  validator in the Safe's setup. That is possible only for new accounts (#116).
- **A two-step owner flow already exists.** `migrate-v4`: step 0 on Base runs through the ordinary owner path. Step 1 on
  Monad is prepared and submitted by the Monad operator through the peer (`RemotePeer.migrateV4`). The Base operator
  mirrors it as an op. The app shows it as the `WhatsNew` steps (`packages/domain/src/app-api.ts`). The Worker rebuilds
  each step's Safe tx before the owner signs (`checkBuilt`, `apps/mamoru-app/src/api/accounts/operator.ts`).
- **The home side of the return leg already exists** (`apps/mamoru-operator/src/return-home.ts`). After the burn it
  fetches Circle's attestation, checks it against the attesters enabled on Base, and sends `receiveMessage` from the
  Base relayer. Today it accepts only burns whose CCTP sender is V4 on Monad.

## What the user authorizes

**One authorization screen. One "Approve" tap per chain, so two passkey prompts, on Base then Monad.** A single prompt
is not possible on these Safes (above). Each prompt signs one Safe transaction. The screen lists both steps and every
line each step signs before the first prompt.

### Step 0, Base: move the account to `conservador-live-v8`

This is the existing renewal with a new target policy. One owner Safe transaction:

- It revokes every v6/v7 grant, bridge-out to Monad included. From then on this account can never send money to Monad
  again, whatever the engine settings say.
- It enables v8's grants, sized for the account's cap.
- It admits the open positions, which stay under management.

### Step 1, Monad: send everything home and end Mamoru's access there

One owner Safe transaction on the Monad Safe, built by the Monad operator:

1. It removes and revokes every session on the Monad Safe. The set is the same as Stop's (`stopRevokes`).
2. If anything is still in a position (if #427 has not run for this account): it closes and burns each position and
   sells the WMON to USDC, at the band's minimums. It is the same plan as Stop.
3. If the Safe holds USDC: `approve(TokenMessengerV2, amount)` then `depositForBurn(amount, domain 6, mintRecipient = the account's Base Safe,
   USDC, destinationCaller = 0, maxFee = 0, minFinalityThreshold = 2000)`.
   - `amount` is the Safe's USDC now, plus the minimum outputs of step 2. Anything above it (slippage gained) stays as
     dust on the Monad Safe.
   - The gas MON stays.

Then, with no signature:

4. The Base operator records the burn and mints it on Base once Circle attests (Standard finality, about 13 to 19
   minutes). The mint is permissionless: if Mamoru is down, anyone can mint the message, and its recipient is fixed.
5. The v8 engine places the USDC that arrives into its targets. Monad's share goes into USDC/cbBTC.

### Order

- Step 0 goes first. It is the one that closes the door to Monad for this account.
- Step 1 can be prepared as soon as step 0 is submitted. It does not need to wait for confirmation, because it moves
  the money only to the user's own Base Safe.
- If step 1 lands before step 0, the USDC waits on the v7 account as savings (the Monad bucket is paused) until step 0
  lands.

### Clicks and signatures (AGENTS rule)

| # | The user | Sees |
|---|---|---|
| 1 | Taps the Home card "Bring your Monad funds to Base" | The authorization screen: the two steps, each with its full summary |
| 2 | Taps "Approve on Base", passkey prompt 1 | "Step 1 of 2 approved", then "Confirmed on Base" a few seconds later |
| 3 | Taps "Approve on Monad", passkey prompt 2 | "On its way to Base: about 15-20 minutes" |
| — | Nothing | Home shows the amount in transit on the Monad row, then in USDC/cbBTC on Base once minted and placed |

Two taps and two passkey prompts. The second tap exists because browsers (Safari) need a fresh user gesture for each
WebAuthn call. Withdrawals stay as they are, one signature each.

### Target policy `conservador-live-v8`

`conservador-live-v7` without the Monad bucket, with Monad's 15 % moved to USDC/cbBTC:

| Bucket | Share | Pools / vaults | Grant |
|---|---|---|---|
| stables | 50 % | gtUSDCp, then waBasUSDC | vault supply (as v7) |
| risk (Balance) | 35 % | WETH/USDC 0.30 % | `manageAnyV3Only` (as v7) |
| btc-usdc | 15 % | USDC/cbBTC 0.05 % | `manageAnyV3Only`, caps at a 15 % share |
| stables-lp | 0 | USDC/USDT 0.01 % | exit only, opt-in (as v7) |

- No remote bucket, no bridge-out grant, no Monad Safe for new accounts.
- Every grant is on MamoruActionPolicyV3 alone, so the approval stays one owner transaction (v6/v7's rule).
- Why these weights: they move only Monad's share. The Stable and Balance positions an account holds are not
  touched, so there are no swaps beyond placing what comes home.
- The pre-Monad v5 weights (50 % USDC/USDT, 40 % cbBTC, 10 % WETH) would also be possible. They mean selling about 25 %
  of each account out of WETH/USDC. They are not chosen; the owner can ask for them, and it is one constant.
- `V8_MIGRATES_FROM`: every earlier Base conservador version, v2 to v7 (and their lab twins). It is offered ahead of
  every other move, so an account in scope is never offered v6 or v7, which open a Monad leg.
- The move waits for any bridge to Monad still in flight (`BRIDGE_IN_FLIGHT`), so that money is counted until it lands.
  The mint on Monad runs from the bridge journal whatever the policy is.

## Prod accounts and the path each takes (read 21 Nov 2026 13:00Z)

Source: the operator's own signed metrics as the Worker stored them (`operator_metrics_latest`, generated 13:00:15Z),
joined with D1 `accounts` and `account_snapshot_latest`. This is a read only. D1's `policy_version` column is `1.0.0`
on every row, so the policy comes from the metrics.

| Account | Env | Policy now | Signed cap | Base USD | Monad USD | Path |
|---|---|---|---|---|---|---|
| 3e4d1d49 | prod | v7 | 10,000 | 2,438.71 | 449.55 | step 0 + step 1 (2 prompts) |
| 63b06f5b | prod | v7 | 10,000 | 1,251.11 | 224.16 | step 0 + step 1 |
| c9d4179b | prod | v7 | 10,000 | 790.48 | 133.89 | step 0 + step 1 (canary settings v16) |
| b22428c7 | prod | v7 | 1,000 | 766.30 | 127.47 | step 0 + step 1 |
| 909fa964 | prod | v7 | 1,000 | 166.49 | 29.84 | step 0 + step 1 |
| 4e2cf182 | prod | v7 | 10,000 | 149.82 | 28.86 | step 0 + step 1 |
| 88264d2f | prod | v7 | 10,000 | 120.35 | 21.72 | step 0 + step 1 |
| c23e94e1 | prod | v7 | 10,000 | 76.35 | 13.68 | step 0 + step 1 |
| 8b0b4d7f | prod | v7 | 10,000 | 2.28 | 0.38 | step 0 + step 1 |
| 307146b5 | prod | v7 | 1,000 | 0.72 | 0.15 | step 0 + step 1 |
| b913a2b0 | prod | v7 | 10,000 | 0.69 | 0.14 | step 0 + step 1 |
| 189692ff | prod | v2 | 100 | 0.87 | — | step 0 only (1 prompt) |
| b54dda3a | beta | v7 | 10,000 | 806.52 | 144.18 | step 0 + step 1 |
| 00a7a1df | beta | v7 | 10,000 | 3.84 | 0.61 | step 0 + step 1 |

- **39 more accounts** (v2) are not active and hold nothing. There is nothing to migrate: their next Start activates v8.
- **No account on v4, v5 or v6** today. **None on V4** (`one_auth_v4` is off).
- **Cannot migrate:** none is blocked by its policy.
  - An owner who lost their passkey cannot sign. That is not visible from here.
  - Three Monad Safes hold under 0.40 USD. Step 1 still revokes their sessions, and it burns whatever USDC they hold
    (Mamoru pays the gas).
  - A step 1 with no USDC at all is a revoke only. The builder takes that case (no burn).
- The monad column is the latest snapshot. After #427 runs it is all USDC.

### New accounts

While the no-Monad rule holds, `activationPolicy` gives v8 to every Start in the scope of the new ops flag `base_v8`,
ahead of v7. The flag is scoped like `vaults_v7` (`*` = everyone).

## Failure states

| What | Result |
|---|---|
| Step 0 refused or failed | Nothing changed, the step reopens. The account stays v7, its Monad money stays in USDC on Monad (paused, #415) |
| Step 0 confirmed, step 1 never signed | Base on v8, no bridge-out grant. The Monad Safe keeps its USDC and its V3 session, which can only manage the growth pool; the entry pause keeps it out. The Monad operator keeps running that Safe's own engine under its own policy, whatever the Base policy is. The Monad row keeps offering step 1 and Withdraw. The account cap still counts the Monad value (peer exposure reads `acc.remote` whatever the policy), so Base never places more than the cap across both chains |
| Step 1 reverts on chain | The Safe tx is atomic: nothing moved, nothing revoked. The step reopens |
| Burn landed, attestation slow | Counted as in flight on Base (ReturnHome `burned`), so the totals do not dip. The app shows it as in transit |
| Mint reverts | Retried with backoff, then alerts after 3 reverts. The money is safe in the message: anyone can mint it to the same recipient |
| Monad operator down at step 1 prepare | `REMOTE_UNAVAILABLE`, retryable, nothing signed |

## Security

- **Recipient pinned.** The Worker rebuilds step 1 with the same builder (`buildReturnHome`, `packages/account`) before
  the owner signs, and refuses (`BUILD_MISMATCH`) unless all of these hold:
  - the Safe is the row's own Monad Safe, re-derived from its keys;
  - `mintRecipient` is this account's Base Safe and the destination domain is 6;
  - `destinationCaller` is 0, `maxFee` is 0 and there is no hook;
  - the hash is equal.
- **No replay across chains.** Each Safe tx hash binds the chain id, the Safe and its nonce.
- **No standing authority left on Monad.** Step 1 revokes the sessions in the same transaction that moves the money.
- **Caps.** The account cap is cross-chain and counts in-flight returns (#355), so it does not change. v8's cbBTC caps
  are sized at its 15 % share.
- **The Base mint.** The home accepts a burn only if Circle's attested message is a burn of Monad USDC to the account's
  own Base Safe, of the reported amount, Monad to Base, with the remote Safe as message sender. A burn whose sender is
  V4 (spec 010) is still accepted as before.
- **The yield fee (#391).** The Monad fee owed is charged on the next Base withdrawal through `remoteFeeBase`. That
  reads the peer's `feeCollectedUsdc` of `acc.remote`, which v8 keeps, so it is not lost.

## Scope of the code

- **PR 1:** this spec.
- **PR 2:** `conservador-live-v8` (+ lab twin) in `packages/policy`, `resolveV8Policy` at boot (v7's contracts),
  `v4Target` and `activationPolicy` prefer v8 under `base_v8`, the renew summary lines, the `base_v8` ops flag, tests.
- **PR 3:** the `return-home` owner kind.
  - Monad operator: plan, hold, submit and status routes, and the shared builder `buildReturnHome`.
  - Base operator: prepare and submit forwarded to the peer, the step mirrored as an op, and the confirmed burn
    recorded in ReturnHome with the remote Safe as sender.
  - Worker: `checkBuilt` covers `return-home/prepare`.
  - The `WhatsNew`-shaped view (`policy: 'base-v8'`) so the existing two-step screen can show it.
- **PR 4 (needs Ot and Brais):** the Home card and the screen copy below. Nothing visible changes until they say yes.

## Copy proposed (needs Ot and Brais's OK)

- Home card title: "Bring your Monad funds to Base"
- Home card body: "Monad has a large token unlock on 24 Nov. Mamoru has moved your Monad position to USDC. Approve
  twice to bring it home and put it to work in USDC/cbBTC on Base."
- Screen points:
  1. "Your USDC on Monad comes back to your Safe on Base"
  2. "Mamoru puts it into USDC/cbBTC; your other positions stay as they are"
  3. "Mamoru stops working on Monad: no more money goes there"
  4. "Two approvals with your passkey, one per network"
- Step buttons: "Approve on Base", then "Approve on Monad".
- In transit: "On its way to Base, about 15-20 minutes".

## Open questions

1. Weights: v7 minus Monad (proposed) or back to v5's 50/40/10?
2. Should accounts that never sign step 1 be reminded? (No push channel today; the Home card only.)
3. After the no-Monad rule ends: is v8 kept as the default, or is a new Monad policy offered as an opt-in?
