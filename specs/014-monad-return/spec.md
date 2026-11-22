# 014: Every account on the Base-only policy; Monad money home, placed in USDC/cbBTC

Ticket: otto/mamoru#428 (milestone "Feedback Monad"). Related: #415 (entry pause, live), #427 (unwind to USDC on Monad,
no signature, done), #410 (depth check), #431 (v8 weights), spec 002 (multichain), spec 010 (one authorization, the
"What's new" flow this reuses), #333 / #361 (one authorization north star), #356 / #322 (V4 blockers), #116 (one prompt
for every chain).
Status: draft r2, 22 Nov 2026. v8 weights approved by Ot (22 Nov); harvested yield goes to a savings layer in the
Stable vault, outside the targets (#413). r1 (21 Nov) is kept below where it still holds. r2 adds: what is built since r1, why the
approval is two passkey prompts and not one, Monad first, the depth-held Safes, the screen copy and the v8 summary for
the owners' OK. Companion files: `plan.md` (operator sequence, idempotency), `tasks.md`, `scenarios.md`, `threats.md`.

## Decision (owner, 21 Nov 2026)

- No new capital goes to Monad until further notice. `entryPause` for chain 143 is live in the engine settings, until
  4102444800.
- Every Monad growth position is closed and its WMON sold to USDC, held on the Monad Safe (#427, existing V3 grants, no
  signature). `chainExit` for chain 143 is in every account's engine settings since 21 Nov.
- Each Monad user is then asked for one authorization that brings that USDC back to their Base Safe and puts it into
  USDC/cbBTC.
- **Scope addition (owner, 21 Nov):** every account, new and old, ends on the newest policy version wherever possible.
  - The Base-only policy (`conservador-live-v8`, below) is the default for every new Start.
  - Every existing Base account (v2-v7) is offered the same one-signature upgrade to it.
  - A Monad account also signs the Monad leg (CCTP back to Base and session revoke).

## Requirements

| Id | Requirement |
|---|---|
| RH-01 | One authorization screen per Monad user lists every line both chains will sign before the first passkey prompt. |
| RH-02 | The Monad leg is one owner Safe tx on the user's Monad Safe: revoke every Mamoru session there (only exception: the depth-held plain path of RH-07 keeps the growth-only session until the WMON is sold), and CCTP-burn the Safe's whole USDC with `mintRecipient` = the same user's Base Safe. Nothing else. |
| RH-03 | The Worker rebuilds the Monad Safe tx with the shared builder, and checks recipient, domain, amount, sessions and hash, before the owner signs (`BUILD_MISMATCH` otherwise). |
| RH-04 | The Base leg moves the account to `conservador-live-v8` through the existing renewal: no remote bucket, no bridge-out grant, USDC/cbBTC taking money. |
| RH-05 | After the burn, minting on Base and placing into v8 need no signature and no person. Every step is idempotent and resumable after an operator restart. |
| RH-06 | Each leg stands alone: any prefix of the flow (none, one leg, both) leaves funds only in the user's own Safes, counted in the totals and the cap. |
| RH-07 | A Safe whose unwind is held (#410, `REMOTE_DEPTH_BELOW_BUDGET`) can still go home in the same single Monad tx, with a price guard on the sale, and a stated residual (any sale output above its minimum) or, when the sale is refused, the USDC home now and the WMON later. |
| RH-11 | Step A is never prepared while any Base → Monad bridge for the account is not terminal (`sending`, `burned`, `dropped`, or `minted` without the mint read on the Safe), and from the first step A prepare the Base operator signs, re-signs and broadcasts no bridge to Monad for the account. |
| RH-08 | No V4 contract, no new contract and no new session-key custody (ships without #356 / #322). |
| RH-09 | Nothing visible changes in the app until Ot and Brais approve the screens and the copy below. |
| RH-10 | v8 is the default for every new Start while the no-Monad rule holds (`base_v8` scope `*`), and offered to every Base account on v2-v7. |

## State on 22 Nov 2026 (read in code at 41a0eb1c)

Built and merged since r1 (not yet visible: `base_v8` is off and no app screen calls `return-home`):

- **v8 policy** (`packages/policy/src/policies-v8.ts`, #431): Stable 50 / WETH-USDC 25 / USDC-cbBTC 25 on v6's
  contracts, `V8_MIGRATES_FROM` v2-v7, offered through the renewal (`v4Target`) and Start (`activationPolicy`) only in
  the `base_v8` scope. No bridge to Monad for an account in that scope (`operator.ts` remote bridge gate). Its renewal
  summary is in "Copy" below.
- **Monad leg builder** `buildReturnHome` (`packages/account/return-home`), the Monad operator's `return-home/prepare`
  and `return-home` routes (held and settled as a Stop), and the Worker's `checkReturnHome` (rebuilds and compares the
  hash, checks the Safe is the row's own and `home` is the owner's Base Safe in the same env).
- **The home side**: the confirmed burn is recorded on the Monad account from the receipt as an owner-signed release
  (`home-<tx>` id), reported in the exposure answer, and adopted by the Base `ReturnHome` only once Circle's attested
  message matches (b67da3ac, aa8abaa4, 3a36ab9a). The Base relayer then calls `receiveMessage`.

Not built: the `WhatsNew` view for this flow (`policy: 'base-v8'`), the Base operator's mirror of the Monad step, the
depth-held variant (RH-07), the Worker's balance and session checks (RH-03 items 4-5), the app screen.

Facts the design rests on:

- **Monad Safe authority.** A v6/v7 account's Safe on Monad carries one V3 session (`liveWmonUsdcMonadV6`,
  `packages/policy/src/policies-monad.ts`, grant `manageAnyV3Only`). It can decrease, collect, burn, mint, increase on
  the growth pool and swap WMON for USDC. It cannot bridge or transfer (operator `noteReturnBlocked`). So the Monad leg
  needs the owner.
- **USDC/cbBTC on v6/v7 is exit only** (preference 0, `exitOnlyV5Grant`). The allocation is part of the signed policy
  and salts the session ids. So placing money into cbBTC on Base needs the owner too.
- **The owner signer.** Every Safe has one owner, `SafeWebAuthnSharedSigner` (Safe passkey module), set at creation.
  The Safe asks it `isValidSignature(hash, sig)` and it verifies a WebAuthn assertion whose `challenge` is exactly
  `hash`. For `execTransaction`, `hash` is the SafeTx EIP-712 hash, whose domain holds the chain id and the Safe.
- **Depth-held Safes.** MamoruActionPolicyV3 refuses every swap and mint on a pool whose instantaneous depth is under
  the session's daily budget (#410). On Monad WMON/USDC that holds the chain exit's WMON sale for some accounts (the
  chain exit returns `REMOTE_DEPTH_BELOW_BUDGET`), and `return-home/prepare` refuses them with
  `MONAD_UNWIND_PENDING`. Decreases are not depth checked, so positions do close.

## Why two passkey prompts, not one

The ticket asks for one passkey approval. With the contracts every account has today, one WebAuthn assertion cannot
authorize both chains. Options evaluated:

| Option | Possible today? | Why |
|---|---|---|
| One assertion over a multi-chain payload (e.g. hash of both SafeTx hashes) | No | The shared signer checks `challenge == hash` for the one hash the Safe asks about. It has no Merkle or batch mode. |
| One SafeTx hash valid on both chains | No | The SafeTx domain separator binds chain id and Safe address (Safe 1.4.1). |
| Owner pre-approves hashes (`approveHash`) | No | The owner is a contract that cannot call. |
| Base Safe tx sends a CCTP message that makes the Monad Safe act | No | Needs a receiver module on the Monad Safe. None is installed, installing one is itself a Monad owner tx. |
| Existing Monad session does the return | No | Its grant has no bridge or transfer. |
| V4 (`registerRemote`, home-driven return) | No | V4 is off: #356 (R7) and #322 (KEY-01) block any V4 grant. |
| Chain-agnostic validator (#116) | Not for existing accounts | It is a new contract added as owner or validator on each chain: one more owner tx per chain, i.e. the same two prompts, plus an audit. |
| **Two assertions, one screen** | **Yes** | One Safe tx per chain, each signed by its own prompt. |

So the floor is two passkey prompts for a Monad user (one for an account with no Monad Safe). The design keeps it to
**one screen, one decision, two taps**: the second tap is needed because Safari and iOS only allow a WebAuthn call
inside a fresh user gesture. The owners are asked to accept this wording (Copy, item C5). One prompt for both chains
stays the goal of #116 for new accounts.

## Can it ship without V4, #356 and #322? Yes

- Both legs use only what every account already has: the Safe, its passkey owner, SmartSession with
  MamoruActionPolicyV3, CCTP V2 on Monad and Base, and v6's Base contracts for v8. No V4 module, no new deployment.
- #356 (R7) is a V4 grant bug. Nothing here grants V4.
- #322 (KEY-01) gates the first V4 grant. v8 grants are V3 sessions under the same key custody as the v6/v7
  sessions they replace, and the leaked-key bound does not grow: same cap C, a USDC/cbBTC grant capped at a 25 % share,
  WETH/USDC cut from 35 % to 25 %, and the bridge-out grant to Monad removed. The Monad session is removed outright.
- The cost: each account later signs once more to reach V4 (#333), when V4 ships. That is the "What's new" migration
  spec 010 already plans, not a new signature this flow adds.

## What the user authorizes

**One authorization screen. Two taps, two passkey prompts: Monad first, then Base.** The screen shows both steps and
every line each one signs before the first prompt (RH-01).

### Step A, Monad: send everything home and end Mamoru's access there

One owner Safe tx on the Monad Safe (`buildReturnHome`), sent through MultiSendCallOnly 1.4.1:

1. `SmartSession.removeSession(id)` for every session still enabled on the Safe (Stop's set, re-read on chain).
2. If the Safe holds USDC: `USDC.approve(TokenMessengerV2, amount)` then
   `TokenMessengerV2.depositForBurn(amount, 6, mintRecipient = the user's Base Safe, USDC, destinationCaller = 0,
   maxFee = 0, minFinalityThreshold = 2000)`. `amount` is the Safe's whole USDC balance at prepare. No hook.
3. Depth-held variant (RH-07, only when the Safe still holds WMON above 0.01 and the chain exit is held by
   `REMOTE_DEPTH_BELOW_BUDGET`): before step 2, `WMON.approve(SwapRouter02, w)` and one `exactInputSingle(WMON → USDC,
   pool fee of the growth pool, recipient = this Safe, amountIn = w, amountOutMinimum = m)`; the burn amount is the
   USDC balance plus `m`. The owner path is not under the action policy, so the depth check does not apply.
   - **`m` from a quote, not from the TWAP.** The operator quotes the whole sale with QuoterV2 on Monad at prepare
     (pool fee and price impact included) and sets `m` = quote less 30 bps. So the swap does not revert for fees or
     impact; it reverts only if the price moves against the Safe by more than 30 bps before inclusion, and a revert is
     atomic (nothing moved, nothing revoked): the step is prepared again with a fresh quote.
   - **Price guard.** The Worker re-quotes on Monad (`MONAD_RPC_URLS`) and refuses unless `m` is within 30 bps of its
     own quote, and unless the quote is no more than 300 bps under the pool's TWAP value of `w` (policy long window). A
     spot pushed away from the TWAP, or a pool too shallow for the whole sale within 300 bps, is refused with
     `MONAD_DEPTH_TOO_LOW`: the Safe then keeps the plain path (USDC home now, revoke deferred, below) or waits for
     the chain exit.
   - **What can stay behind, stated without a bound.** A Safe tx carries fixed amounts, so it cannot burn "whatever the
     swap returned". Any USDC the sale returns above `m` stays on the Monad Safe: expected about 30 bps of the sale, but
     more if the price moves in the Safe's favor before inclusion. It is the owner's, in the owner's Safe, shown on the
     Monad row, and leaves with an ordinary withdrawal (one signature, as every withdrawal). Bringing it home without a
     signature would need a session left on the Monad Safe or a contract that burns the post-swap balance; both are
     out of scope (RH-08). Owners decide (open question 5).
   - **When the Worker refuses the sale** (`MONAD_DEPTH_TOO_LOW`): step A is offered as the plain path, which burns the
     Safe's USDC and **keeps** the growth-only session, so the chain exit can still sell the WMON when depth allows; a
     later step A (send-only plus revoke) takes the proceeds home. Two Monad prompts for these Safes, stated in the
     screen. Their USDC never waits on Monad for the WMON.
   - A still-open position (should not happen: decreases are not depth checked) keeps the prepare refused.
4. The MON for gas stays. Mamoru pays the gas (no refund in the Safe tx).

Then, with no signature: the Base operator records the burn, waits for Circle's attestation (Standard finality, about
13-19 minutes), checks the message and mints it on Base. The mint is permissionless: if Mamoru is down, anyone can relay
the attested message, and the recipient cannot change.

### Step B, Base: move the account to `conservador-live-v8`

The existing renewal with v8 as its target. One owner Safe tx:

- It revokes every v6/v7 grant, bridge-out to Monad included. From then on the account can never send money to Monad.
- It enables v8's grants, sized for the account's cap, and admits the open positions.

Then the engine places what is idle on the Base Safe (the return included) into v8's targets; the Monad share goes to
USDC/cbBTC (`plan.md`).

### Order: Monad first (r2 change)

r1 put Base first. r2 puts Monad first:

- Step A ends Mamoru's exposure on Monad and starts the 15-20 minute transfer. It is the one tied to the 24 Nov unlock.
- Step A does not depend on v8. If the owners have not yet approved v8's weights, the screen offers step A alone, and
  the USDC waits on the Base Safe as idle savings (the v7 Monad bucket is entry-paused, so it is never bridged back).
- Either step alone is safe (RH-06, failure table). Base first gave no extra safety: the entry pause and the `base_v8`
  bridge gate already stop new money going to Monad.
- An account with no Monad Safe (v2) sees step B only.

### Clicks and signatures

| # | The user | Sees |
|---|---|---|
| 1 | Taps the Home card | The authorization screen: two steps, each with its full summary |
| 2 | Taps "Approve on Monad", passkey prompt 1 | "Step 1 of 2 done. Your USDC is on its way to Base" |
| 3 | Taps "Approve on Base", passkey prompt 2 | "Done. Mamoru will put it to work when it arrives" |
| — | Nothing | Home: the amount in transit on the Monad row, then on Base, then in USDC/cbBTC |

Withdrawals stay as they are, one signature each.

## Target policy `conservador-live-v8`

`conservador-live-v7` without the Monad bucket. Weights of 22 Nov (#431), **approved by Ot on 22 Nov**:

| Bucket | Share | Pools / vaults | Grant |
|---|---|---|---|
| stables | 50 % | gtUSDCp, then waBasUSDC | vault supply (as v7) |
| risk (Balance) | 25 % | WETH/USDC 0.30 % | `manageAnyV3Only` (as v7), caps at a 25 % share |
| btc-usdc | 25 % | USDC/cbBTC 0.05 % | `manageAnyV3Only`, caps at a 25 % share |
| stables-lp | 0 | USDC/USDT 0.01 % | exit only, opt-in (as v7) |

- No remote bucket, no bridge-out grant, no Monad Safe for new accounts.
- Every grant is on MamoruActionPolicyV3 alone, so the approval stays one owner tx.
- An account from v7 holds 35 % in WETH/USDC: 10 points over target, past the 5-point drift band (`DRIFT_BPS`), so the
  usual reduce brings it toward 25 %, one op per review, and USDC/cbBTC takes that money.
- Alternative not chosen (Ot chose 50 / 25 / 25): v5's 50 % USDC/USDT, 40 % cbBTC, 10 % WETH (one constant; sells about 25 % of each account
  out of WETH/USDC).
- The move waits for any bridge to Monad still in flight (`BRIDGE_IN_FLIGHT`).

## Prod accounts and the path each takes (read 21 Nov 2026 13:00Z)

Source: the operator's signed metrics as the Worker stored them, joined with `accounts` and
`account_snapshot_latest`. Read only.

| Account | Env | Policy now | Signed cap | Base USD | Monad USD | Path |
|---|---|---|---|---|---|---|
| 3e4d1d49 | prod | v7 | 10,000 | 2,438.71 | 449.55 | A + B (2 prompts); depth-held on 21 Nov (#410) |
| 63b06f5b | prod | v7 | 10,000 | 1,251.11 | 224.16 | A + B |
| c9d4179b | prod | v7 | 10,000 | 790.48 | 133.89 | A + B (canary settings v16) |
| b22428c7 | prod | v7 | 1,000 | 766.30 | 127.47 | A + B |
| 909fa964 | prod | v7 | 1,000 | 166.49 | 29.84 | A + B |
| 4e2cf182 | prod | v7 | 10,000 | 149.82 | 28.86 | A + B; depth-held on 21 Nov (#410) |
| 88264d2f | prod | v7 | 10,000 | 120.35 | 21.72 | A + B |
| c23e94e1 | prod | v7 | 10,000 | 76.35 | 13.68 | A + B |
| 8b0b4d7f | prod | v7 | 10,000 | 2.28 | 0.38 | A + B |
| 307146b5 | prod | v7 | 1,000 | 0.72 | 0.15 | A + B |
| b913a2b0 | prod | v7 | 10,000 | 0.69 | 0.14 | A + B |
| 189692ff | prod | v2 | 100 | 0.87 | — | B only (1 prompt) |
| b54dda3a | beta | v7 | 10,000 | 806.52 | 144.18 | A + B |
| 00a7a1df | beta | v7 | 10,000 | 3.84 | 0.61 | A + B |

- 39 more v2 accounts are inactive and hold nothing: their next Start activates v8.
- None on v4, v5, v6 or V4.
- Which Safes are depth-held is re-read at prepare time, not taken from this table.
- A step A with no USDC is a revoke only. Three Monad Safes hold under 0.40 USD: step A still revokes their sessions.
- An owner who lost their passkey cannot sign either step; their Monad Safe keeps its USDC and one growth-only session
  under the entry pause.

## Failure states

| What | Result |
|---|---|
| Step A refused at prepare (`MONAD_UNWIND_PENDING`, `BRIDGE_IN_FLIGHT`, `REMOTE_UNAVAILABLE`, `BUILD_MISMATCH`) | Nothing signed. The step stays offered. |
| A Base → Monad bridge is not terminal when the owner opens the screen | Step A waits (`BRIDGE_IN_FLIGHT`, RH-11) until the Monad operator reads the mint on the Safe, so that USDC goes home in the same burn. Step B can be signed meanwhile. |
| USDC reaches the Monad Safe after step A anyway (a mint relayed late by a third party despite RH-11) | Home shows it on the Monad row and offers step A again, a send-only tx (no session left). One more prompt; RH-11 makes this a fault case, not a path. |
| Step A reverts on chain | Atomic: nothing moved, nothing revoked. The step reopens. |
| Step A confirmed, step B never signed | Monad: no session left, gas MON stays. Base: v7, the return lands as idle USDC (Monad bucket entry-paused, never bridged back). Home keeps offering step B. |
| Step B confirmed, step A never signed | Base on v8, no bridge-out grant. The Monad Safe keeps its USDC and its growth-only session under the entry pause; its own engine keeps running there. Home keeps offering step A and Withdraw. The cap still counts the Monad value. |
| Burn landed, attestation slow | Counted in flight (`burned`), totals do not dip. The app shows it in transit. |
| Attestation never matches (wrong recipient, amount, domain or sender) | Not adopted, not minted by Mamoru; alert. Cannot happen with a burn the Worker checked (RH-03). |
| Mint reverts | Retried with backoff, alert after 3. The message stays mintable by anyone to the same recipient. |
| Operator restarts between burn and mint | The release is in state; the home re-reads it from the Monad exposure answer and resumes (`plan.md`). |

## Copy (needs Ot and Brais's OK)

Nothing below ships until both say yes (RH-09). Text is what the user reads; it is in English like the rest of the app.

**C1. Home card** (Monad users with a Monad Safe that still has a session or USDC)

- Title: "Bring your Monad funds to Base"
- Body: "Mamoru has moved your Monad position to USDC. Approve to bring it to your Safe on Base and put it to work in
  USDC/cbBTC."
- Button: "Review"

**C2. Authorization screen**

- Title: "Leave Monad"
- Points:
  1. "Your USDC on Monad comes back to your Safe on Base, through Circle (about 15-20 minutes, no fee)"
  2. "Mamoru stops working on Monad: no more money goes there"
  3. "On Base, Mamoru aims for 50 % Stable, 25 % WETH/USDC and 25 % USDC/cbBTC"
  4. "Two confirmations with your passkey, one per network"
- Step A card: "On Monad" + the operator's summary lines (C4) + button "Approve on Monad"
- Step B card: "On Base" + the renewal summary lines (C4) + button "Approve on Base"

**C3. Progress and done**

- After step A: "Step 1 of 2 done. Your USDC is on its way to Base"
- After step B: "Done. Mamoru will put it to work when it arrives"
- Home, Monad row in transit: "On its way to Base, about 15-20 minutes"
- Step A refused while unwinding: "Mamoru is still moving your Monad position to USDC. Try again in a few minutes"

**C4. Summary lines already in code** (shown inside the step cards; the owners review them as copy)

- Base renewal to v8 (`operator.ts`, #431):
  - "Mamoru stops sending money to Monad: on Base it aims for 50% in Stable, 25% in WETH/USDC, 25% in USDC/cbBTC"
  - "Your Safe on Monad <address> keeps what it holds until you approve sending it to this Safe, the next step"
    (r2: with Monad first this line changes to "Your USDC on Monad comes here with the other step" when step A is
    already done or offered on the same screen; needs OK)
- Monad step (`planReturnHome`):
  - "Revoke the engine's N session grant(s) on your Safe on Monad: Mamoru stops working there"
  - "Send X USDC from your Safe on Monad to your Safe on Base <address>, through Circle's CCTP (about 15-20 minutes, no
    fee)"
  - "On Base, Mamoru puts it to work in your positions there"
  - "The MON left for gas stays in this Safe"
  - Depth-held variant adds: "Sell Y WMON for at least Z USDC first, and send Z too. Any USDC above Z stays in this Safe; you can withdraw it"

**C5. The word "one".** The ticket says one approval. The screen says "Two confirmations with your passkey, one per
network" because two OS prompts appear (section "Why two passkey prompts"). Owners decide between this and "One
approval, confirmed twice with your passkey".

**C6. Weights.** Decided: 50 / 25 / 25 (Ot, 22 Nov). The percentages in C2 and C4 follow them; the wording still needs both owners' OK.

## Open questions (for the owners)

1. ~~Weights~~ decided (C6).
2. Wording of the two prompts (C5).
3. Accounts that never sign step A: the Home card only (no push channel today), or also an email if the account has one?
4. After the no-Monad rule ends: v8 stays the default, and a Monad policy comes back as an opt-in?
5. Depth-held Safes: sell in step A and leave any output above the minimum on Monad (withdrawable), or always use the plain path (USDC home now, WMON sold by the chain exit, a second Monad prompt later)?
