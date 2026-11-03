# MamoruActionPolicyV4: threat model (spec 010 one authorization, amendment A1)

Scope: `src/MamoruActionPolicyV4.sol` (with `MamoruV4Helper`, created by V4), `src/MamoruGasPolicyV2.sol`, `src/MamoruV4Table.sol` (`MamoruV4Chains`, `MamoruV4Classes`), `src/MamoruRemoteSafe.sol` (`MamoruRemoteInit` and the initializer encoders), `src/MamoruMigrationCheck.sol`, `src/MamoruV4Lens.sol` (views only) (otto/mamoru#292, #316, #317). Not deployed and not audited. Results: `specs/010-one-authorization/results/t2-t4-contracts-2026-11-02.md` (r2) and `specs/010-one-authorization/results/t1c-a1-probe-2026-11-02.md` (A1).

The account carries **one** SmartSession session per chain: a single fallback action (`FALLBACK_TARGET_FLAG`) whose only action policy is V4, and `MamoruGasPolicyV2` as its only userOp policy. The owner signs once (`InitV4`: the cap C, the generation, and for a remote Safe its home). **Nobody holds a key over V4 after deployment** (A1, spec 009 C2-C6): no guardian, no registry, no admin, no owner, no upgrade, no pause. Which pools are eligible follows from rules checked at every use; vaults and chains are exact tables in code (`MamoruV4Table`); everything that could send value elsewhere (router, position manager, messenger, transmitter, tokens, Safe stack, the remote's shape) is a constant. A new token, vault, class or chain is a new table, so a new V4 version the owner adopts with one opt-in signature (`ADD-A-CHAIN.md`).

Adversaries: a leaked **session key** (or a misbehaving operator); an outsider with capital (pools, prices); Circle (CCTP). Not covered: anything the owner signs (withdrawals, Stop, rotations, migrations, adopting a version), Circle's issuer powers over USDC, Uniswap, Safe, Rhinestone's code as deployed, and a listed vault curator's conduct inside the vault's share of C.

## I1: funds land only in the owner's Safes; approvals only to V4

| Check | Threat | Why it holds |
|---|---|---|
| `checkAction` admits only: V4's own functions (`swap`, `mint`, `increase`, `deposit`, `redeem`, `bridge`, `registerRemote`, `clock`, `checkExit`, `assertZero`, `announceReady`); `approve(V4, x)` on any target but the position manager; the position manager's `decreaseLiquidity`, `collect` (recipient the account), `burn` of admitted positions; `receiveMessage` on the pinned CCTP transmitter; wrap / unwrap of the native coin. Everything else is FAILED. | A key approves the router, a vault, the messenger or itself, calls them directly, transfers, withdraws the EntryPoint deposit, calls the Safe itself (installModule, setRegistry, owner changes). | The fallback action sends every call of every session op through `checkAction` (T1). Tested at validation through the real stack (`V4UserOpFork.test_validationRefusals`: a call to the Safe, `installModule`, a direct router swap, a transfer, approvals to others) and directly (`test_I1_checkActionAdmitsOnlyV4AndExits`). |
| Each V4 spending function pulls the exact amount from `msg.sender`, approves the pinned counterparty for exactly that amount, acts with the account as recipient, resets the allowance to 0 and returns any rest. | The counterparty pulls more, or an allowance lingers on the router / manager / vault / messenger. | Tests assert allowances back to 0 and nothing left in V4 after every action. |
| Every non-zero `approve` in a session batch is followed by its reset and `assertZero(token)` (MamoruGasPolicyV2, spec 009 POL-07). | An allowance to V4 outlives the batch. | Even then it is inert: V4 only pulls from `msg.sender`, inside its own checked functions (`test_I1_leftoverAllowanceIsInert`). |
| Every check of V3's swap / mint / increase / vault / bridge paths, and an exit's price check (`checkExit`), runs at **execution**, with the account as `msg.sender`. | A check at validation and an action at execution see different states (V3's LeftClaw M-2 window). | No window; a failing check reverts the action (nothing charged, nothing moved; the op's gas still advances the gas rate). |
| Native value only in `deposit()` on the chain's pinned wrapped native, `withdraw(uint256)` there with value 0 (#307). | Native value leaves. | WETH9 credits and pays back `msg.sender`, the account (`test_checkAction_nativeValueOnlyToWrap`, `test_sibling_valueElsewhereRefused`). |
| The session cannot sign for the account. | A leaked key signs a `permit` / Permit2 order. | The V4 session has no ERC-1271 policy; SmartSession refuses (`test_sessionKeyCannotSignForTheAccount`). |

## Eligibility by rule, and the tables (A1; replaces MamoruRegistry)

| Check | Threat | Why it holds |
|---|---|---|
| A pool is eligible for an entry when (1) it is `factory.getPool(t0, t1, fee)` of the chain's pinned factory, (2) both tokens are pinned, one a pinned stable, and the pair has a class, (3) its fee is in the class's fee set, (4) its observation ring holds at least the class's long window (T6 L-4, kept; #345 P2-2: slot0's filled `observationCardinality`, not `observationCardinalityNext`, which one call raises before any slot is written), and `observe` serves it, (5) its in-band depth covers 20 x the call (I2), (6) a stable pair's price is within the parity anchor, (7) its long TWAP and its spot are within the class's band of the pair's pinned reference pool. (`MamoruV4Helper.priced`.) | An outsider creates a pool of pinned tokens on a new fee tier or a thin chain, holds its price, supplies the depth. | Rule 7 binds such a pool to one band of the market the reference pool shows; the per-asset sub-bucket caps all pools of an asset together (a second pool adds no room). Tests: `test_A1_rule2_*`, `test_A1_rule3_feeSet`, `test_A1_rule7_referencePoolAndSharedSubBucket`, `test_trapPoolRefused`. |
| Class parameters (windows, band, anchor, ratio, fee set) are rows of `MamoruV4Classes`, checked against V3's hard bounds by `test/MamoruV4Classes.t.sol`. | A wrong parameter. | Nobody can change one after deployment; a mistake stays until a new version, so the unit test and the fork deploy test (`DeployV4Fork`: every reference pool eligible on its chain) are the gate before T7. |
| Vaults: the exact addresses of the chain's table, each with a pinned stable as `asset()` and a ratio <= `MAX_VAULT_RATIO_BPS` (`MamoruV4Helper.vaultEntry`, the one place the vault model lives). | Anyone can create a MetaMorpho vault with a hostile curator; without an admin nobody vets it. | Only listed vaults (`test_A1_hostileCuratorVaultNotListed`, `test_hostileVaultRefused`). |
| **Exits are never gated by eligibility**: decrease, collect, burn of an admitted position and redeem from a listed vault work whatever the pool's eligibility is now; `checkExit` prices the decrease with the pair's class only. **A fast move** (#345 P2-1): the exit range (`MamoruV4Helper.exitRange`) is always the hull of the bands around the long and short TWAP, [min - band + 1, max + band]. V3's intersection left out the spot once the TWAPs were more than band apart (empty past 2 x band), so a crash refused exits for up to the long window. Residual: in the first minutes of a move (at most the 5 min short window), a spot more than one band past both TWAPs is still refused. | A pool that stops being eligible (thin, depegged, delisted by the factory) locks positions; a fast move locks them for 30 min; a sandwich uses the wider range. | `test_A1_ineligiblePoolIsExitOnly`, `test_M6_depegDoesNotLockTheExit`, `test_345_fastCrashDoesNotBlockTheExit`, `test_345_exitPassesThroughoutACrash` (steps of 230 and 450 ticks, sampled from 5 to 30 min). The hull never accepts a spot more than one band past both TWAPs, and a one-block push moves its edges by a few ticks only: `test_345_manipulatedSpotCannotExtractBeyondTheBand`, `test_345_crashThenPushPastTheHullRefused`. Entries keep the intersection and the anchor. |
| Chains: a row of `MamoruV4Chains` per chain id (factory, position manager, router, stables, assets, wrapped native, CCTP domain, gas rate). A chain outside the table refuses every enable and every validation. CCTP domain 0 is Ethereum, never a sentinel. | A route to an unverified chain. | `test_unsupportedChainFailsClosed`, `test_A1_nothingOutsideTheTables` (Arbitrum's domain refused). |
| Safe stack and CCTP code hashes at every enable (singleton, factory, MultiSend, Safe7579, launchpad, shared signer, SmartSession, OwnableValidator, TokenMessengerV2, MessageTransmitterV2). | A chain where the canonical address runs different code. | `BadStack` (tested by etching one). |
| `MamoruV4Table`, the gas policy, V4, its helper and `MamoruRemoteInit` are CREATE2 with chain-independent init code. | "The same address" means different code on another chain. | `DeployV4Fork.test_sameAddressesEverywhere`, `V4RemoteFork` setUp. |

## I2: price and depth

V3's two-TWAP range, anchor, swap bounds, mint/increase minimums at the spot, decrease minimums without the anchor (M-6), on the hull of the two TWAP bands (#345 P2-1, see the exits row above): in `MamoruV4Helper`, run at execution, with the class's parameters. At every priced use the in-band depth must cover `DEPTH_MULTIPLE` (20) times the call's value (LeftClaw M-5; the walk is capped at 64 steps per direction, which can only refuse more).

## I3: positions

As V3: only positions minted through V4 or admitted in an owner-signed Init. The account-wide Init revokes a position for good (M-4). Validation of decrease / collect / burn is static (an admitted position, from the account's own storage); ownership is checked by `checkExit` and by the position manager itself at execution.

## I4: the remote Safe and readiness (A1: by CCTP, not by a key)

| Check | Threat | Why it holds |
|---|---|---|
| `remoteOf` is computed by V4 from the account's **current** owners, threshold and passkey, the domain, the session key and V4's canonical initializer; `registerRemote` acts on `msg.sender` only. | A key names another account's state; a revoked key is carried into a new remote (r2 P0). | `test_I4_registerRemoteWithAnotherAccountsStateRefused`. |
| The initializer reads only code and immutable state (Safe7579 with the ERC-7484 registry off, SmartSession in UNSAFE_ENABLE). | The remote cannot be deployed after funds were minted to it (r2 P0-1). | `test_I4_remoteEndToEnd` (minted first, deployed after), `test_I4_remoteDeploysAnyDay`. |
| **Readiness.** On the remote's chain anyone calls `announceReady(safe, homeDomain, sessionKey)`: V4 there reads the Safe back (SafeProxy 1.4.1 code hash, the pinned singleton, Safe7579 enabled, SmartSession installed) and requires the named V4 session to be enabled in SmartSession and bound to this V4 at the current generation (a stopped Safe cannot be announced) and requires that `safe` is the canonical remote of its home recomputed from its own owners and `sessionKey`, then sends `(home, safe, ownersHash)` through the pinned MessageTransmitterV2 to the same V4 on the home domain (finality 2000, open destination caller). The home's V4 accepts it in `handleReceiveFinalizedMessage` only from the pinned transmitter, from `address(this)`, from a table domain other than its own, at finality >= 2000, and writes readiness only for the registered remote with the same owners hash, which must also be the account's current one. Unfinalized messages always revert. A home Safe announces to its sibling the same way (`home == safe`). | A burn to an address nobody verified (r4 P0); a burn during a rotation (r3 P0-1); a look-alike Safe with the victim's owners announcing; a forged message. | No key: the read-back the guardian used to do off chain is done by code, and the only trust added is CCTP, which already moves the funds. A forged message (only Circle could forge one) passes only for the address V4 itself computed, the user's own Safe, deployable by anyone. Any owner change clears readiness. Tests: `test_A1_stoppedSafeCannotBeAnnounced`, `test_I4_remoteEndToEnd` (a real CCTP V2 message Monad -> Base through `receiveMessage`, relayed by the account's own session), `V4EthereumSiblingFork` (Base -> Ethereum), `test_A1_readinessMessageChecks`, `test_A1_announceReadyRefusals`, `test_I4_ownerChangeClearsReadiness`. |
| A remote Safe bridges only to its `home`, on its `homeDomain`, with no readiness check. | A remote's funds go anywhere else. | The home exists by construction (it registered the remote through its own V4 session). |
| Every burn is CCTP V2 Standard (finality 2000) with a `maxFee` the caller names, at most the chain's pinned `cctpFeeCapBps` of the amount (10 bps on Base, Monad and Ethereum; the table's value <= `MAX_CCTP_FEE_CAP_BPS` = 100, checked by `DeployV4.checkTable` and `test_cctpFeeCap`). A non-zero `maxFee` is charged in full to the account bucket, the 24 h and the 30-day caps (sub-bucket key: the messenger, at 100 % of C); `maxFee = 0` charges nothing (#345 P2-5). | V3 pinned `maxFee = 0`: a fee added by Circle to Standard transfers reverts every burn, bridge-back included, until a new V4. A leaked key burns value to Circle hop after hop. | The fee goes to Circle's fee recipient, never to the controller. Its rate is bounded per burn by the cap and in total by C per 24 h. No absolute ceiling: the bps cap scales with the amount and a flat ceiling would refuse large bridges again. Residual: with a non-zero fee, a bridge-back waits for bucket room for the fee (at most 10 bps of the amount). `test_345_bridgeMaxFeeCappedAndCharged`. |

Residual (accepted in the spec): a compromised (not lost) passkey controls every remote until rotated there; a leaked session key can choose the remote's session key (bounded by V4 on the remote) and can keep re-registering to clear readiness (griefing, no loss); Circle can withhold attestations (bridging and readiness stop, funds at rest do not).

## I5: the account's budget per chain

| Limit | Mechanism | Crossing call |
|---|---|---|
| Account bucket | Token bucket of capacity C, refilled C per day. | Reverts `BudgetExceeded(0)`. |
| Per asset / per stable class / per vault | Token bucket of `ratioBps x C` (the class's or the vault's ratio), same refill; a capacity change settles the refill at the old rate first (LeftClaw M-3). One sub-bucket per volatile asset shared by all its pools and fee tiers. | Reverts `BudgetExceeded(key)`. |
| Rolling 30 days | Sum over 31 daily periods <= 3C. | Reverts `Cap30Exceeded`. |
| Rolling 24 h | Sum over 25 hourly periods <= C. | Reverts `Cap24hExceeded`. Nothing pauses (A1). |

No lifetime total and no review threshold (spec 010 Decision, A1): the conservative bound is the whole permitted spend, C per 24 h and 3C per 30 days per chain, with no end in time until the owner stops the session on every chain (`test_A1_noLifetimeTotal`). Vault exposure is capped at the position: the account's current holding in a vault (its own accounting, rounded against the depositor) plus a deposit stays within `ratioBps x C` (`test_listedVaultExposureCapped`).

## I6: gas (`MamoruGasPolicyV2`), A1

Per-op caps on every gas field and the max fee, then a clock-free GCRA rate per account: each op costs its prefund `(call + verification + preVerification + paymaster limits) x maxFeePerGas`, charged at validation against the claimed time T of the batch's leading `clock(T)`; the policy returns `validAfter = T - S`, `validUntil = T + S` (S = 5 minutes), which SmartSession intersects and the EntryPoint enforces (`test_claimedTimeOutsideSlackRefused`: AA22 outside S). At most G per W plus a burst of G (Base 0.002 ETH a day, Monad 1 MON, Ethereum 0.01 ETH), reverting ops included, no reviewer, nothing to reset (`test_gasGriefingHitsTheRate`: 3 ops a day at the caps, 31 days at most G each, then the next window serves again). The batch shape (batch mode, default exec type, leading clock, no action-free op, `checkExit` before each decrease, approve reset + `assertZero`) is checked statelessly on the whole `userOp.callData`.

## I7, I8: no guardian, nothing to add or remove

V4, the gas policy and the table have no guardian, no pause state, no `review`, `setReady`, `cancel`, no owner and no setter (`DeployMamoruV4.forbiddenSelectors`, refused by the deploy script's `check` and by `test_deploymentShapeAndSizes`). Every constructor argument is an address of the same stack (gas policy, table), identical on every chain.

## Deployment (T7)

`script/DeployV4.s.sol` deploys the stack at the addresses `predict()` gives and pins them (`EXPECTED_*`); `run()` checks the wiring inside forge's simulation and `DeployV4Fork` on forks. Neither proves what a chain holds once the transactions landed. **After every broadcast, on each chain, `forge script script/DeployV4.s.sol --sig "verify()" --rpc-url <chain>` runs `check(predict())` against that chain's live RPC** (#345 P2-3): pinned addresses, code, wiring, no forbidden selector, the table's rows and reference pools, the ModuleRecords. Nothing is announced or offered for adoption on a chain until it passes there.

## Threat model, worst case per chain (C = the owner's cap)

| Who | Bound | Measured |
|---|---|---|
| Leaked session key | Trades at a bad price within the bands: the whole permitted spend, C per 24 h, 3C per 30 days per chain, with no end in time until the owner stops it; one listed vault holds at most `ratioBps x C <= C/2`. Funds only reach the user's own Safes. | Single-block sandwich on WETH/USDC 0.3 % at its class: 18 bps of C on the day, stopped by WETH's 15 % sub-bucket (`test_worstCaseDailyLossAtTheClass`). |
| Leaked session key, gas | G per W plus a burst of G per chain. | Above. |
| Outsider with capital | A pool of pinned tokens is usable only within one band of the reference pool, under the asset's sub-bucket. | `test_A1_rule7_*`. |
| Circle (CCTP) | Withholding stops bridges and readiness, never funds at rest. A forged readiness only names V4's own computed address. | |
| Compromised operator | Within I1-I6; withdrawal stays owner-only; refusal stops Mamoru's offer, not the user. | |
| The Mamoru team after deploy | Nothing on V4. | |

## Migration (v2-v6 -> V4)

One owner Safe transaction: `removeSession` for every old id; `revokeEnableSignature` for every old id; self-attest V4 and the gas policy; enable the V4 session (positions admitted in its Init); then `MamoruMigrationCheck.assertMigrated(account, [v4 id], oldIds, noncesBefore)`. The check reverts unless:
- the V4 session is the only one enabled, read from SmartSession's own `getPermissionIDs` (`assertOnly`);
- every old id's ENABLE nonce (`getNonce`) moved past the value the operator read when building the transaction.

On a revert the Safe reverts the whole transaction (GS013).

Why the revocation (review r1 of #200, P1): `removeSession` does not touch `$signerNonce[id][account]`, over which SmartSession verifies an owner-signed ENABLE payload. An unused payload from a v2-v6 renewal would otherwise re-enable the old session after the migration, outside V4. The fork test shows exactly that on the first version of the migration (`test_enableReplayReEnablesAnOldSessionWithoutRevocation`), and shows it refused after the fix (`test_enableReplayRefusedAfterMigration`). `assertNone(account, ids)` remains as the spec's narrower check.

**Rule (review r2 of #200, P1): Mamoru never asks the passkey to sign a SmartSession ENABLE payload.** Owner signatures are Safe transaction hashes only (`enableSessions` inside `execTransaction`; a remote's session is committed in its Safe setup), and an ENABLE digest is a different EIP-712 hash, so no other owner signature can stand in for one. The set of signed-but-unused ENABLE payloads is therefore empty, and an old id the migration's list misses carries none. `packages/account/sessions/no-enable-mode.test.ts` fails if any production file under `apps/` or `packages/` (test code and `packages/scenarios` exempt) builds the ENABLE mode or an enable digest. Any future multichain-enable design (#230) must revoke by nonce and get its own security review before that guard is relaxed. Residual covered on chain: an old id that is still *enabled* but missing from the list is caught by `assertMigrated`'s "the V4 session is the only one enabled". Measured: 1.73M gas for a v6-shaped account (9 + 9 + 3 actions).

## ERC-7562 (A1, spec 009 POL-12)

V4's `checkAction` reads only the account's own storage (every mapping has the account as its last key, `_admitted[tokenId][account]` included). Its one external call is `TABLE.chain(block.chainid)` (#345 P2-4): a `pure` function of `MamoruV4Table`, a contract with no storage, so the call reads only code, the same for every account, and touches no storage slot. ERC-7562 bounds storage access and opcodes, not calls into a contract that has code (OP-041 bans calls to an address without code), so the call is allowed; the gas policy writes only `tatOf[account]` and reads no clock. `test/V4Erc7562Fork.t.sol` records every opcode of the account's `validateUserOp` (Safe, Safe7579, SmartSession, both policies, the table) for a swap, an exit, a bridge and a readiness-relay batch and applies OP-011, OP-012, OP-061 and STO-010/021: no violation in any frame. What a live bundler adds (OP-041, reputation) is in the T1c results.

# MamoruActionPolicyV3: threat model of each check

Scope: `src/MamoruActionPolicyV3.sol` (otto/mamoru#116 T1), with `MamoruV3Routes`, the vault and bridge checks V3 calls. Not deployed and not audited.

The adversary is someone holding a **session key**: a leaked operator key, or the operator itself if it misbehaves. The key signs userOps for the account. SmartSession lets an action through only when its (target, selector) is in the grant and every action policy on it returns success. V3 is meant to be the **only** action policy on every action of a Mamoru grant. Grants then need no UniActionPolicy param rules, and in particular no `ACCOUNT` refs, whose value is circular at setup time. That lets them be enabled inside the Safe setup (SmartSession `UNSAFE_ENABLE`, design D).

What V3 protects: **no session action moves value to anyone but the account**. The secondary goal is to keep the Uniswap paths inside V2's price and budget envelope. What it does not protect: anything the owner signs (Stop, withdrawals, renewals), and gas spend, which MamoruGasPolicy and TimeFramePolicy cover as userOp policies.

"account" below means the `account` argument SmartSession passes, which is the smart account being validated (the Safe). A session key cannot choose it.

## Common to every family

| Check | Threat | Why it holds |
|---|---|---|
| `msg.sender == SMART_SESSION` on `initializeWithMultiplexer` | Anyone writes an account's generation or bindings. | Only SmartSession calls this, from an owner-executed enable, an owner-signed ENABLE-mode op, or the Safe's own setup (UNSAFE_ENABLE in `onInstall`, which runs in the account's setup). A session key reaches none of these. |
| `msg.sender == SMART_SESSION` on `checkAction`, else FAILED | Someone spends an account's budget (it is charged at validation) through a direct call. | Only SmartSession validates. |
| Binding per (ConfigId, account), and a revert when absent | A grant enabled for one account is used for another. | SmartSession derives the ConfigId per permission and account. |
| `b.generation == generationOf[account]` | A key from an older approval keeps acting after a renewal. | Any owner-signed Init with generation + 1 retires every older binding of the account, in every family. |
| `isPaused(account)` | A leaked key keeps acting while the incident is handled. | The revoke-only guardian stops all three families. It cannot enable, widen or move anything. |
| `value == 0` | Native ETH leaves with a call. | No family needs value. |
| Init family by first word (`0x20` = V2's Uniswap `Init`; `1` = vaults; `2` = bridge; `3` = Uniswap at setup) | A Uniswap Init is read as a family Init, or the other way round. | `abi.encode` of V2's Init, a struct with a dynamic member, always starts with the offset 0x20, and family tags are 1, 2 and 3. Any other first word reverts (`BadInit(12)`), so a grant never binds by accident. |
| Setup mode (`abi.encode(3, Init)`): the enable reads no live market state | A frozen setup initializer becomes undeployable on a chain where bridged funds already wait at its address (review P1 of #158). | Outside setup, a Uniswap enable reads the pool's observation ring (T6 L-4) and its in-band depth (LeftClaw M-5), both of which the market can change. In setup mode those reads move to the config's first swap, mint or increase (`_liveChecks`); until they pass, those actions are refused and nothing else changes (decrease and collect of admitted positions never wait). `admit` must be empty (`BadInit(13)`), because admission reads the position manager. What the enable still reads is the pool's identity (token0, token1, fee, the factory's mapping), which is immutable once the pool exists. The mode is bound: it is accepted only for the account's first config of that pool (and that generation's siblings), so every renewal runs the live checks at enable (`BadInit(14)`); and it is part of the config hash, so one generation cannot mix modes, in either order (`ConfigMismatch`, raised before any live read, so a mixed list fails the same way on any day). It cannot be spoofed into a weakening: only SmartSession reaches the init, with owner-authorized data, and the mode moves the two checks, it never removes them. Residual: the session key chooses when the deferred M-5 runs, so a just-in-time in-band liquidity add can pass it once per account and pool; outside setup the operator already chooses when the enable lands, so this widens little. |

## Uniswap v3 (V2 unchanged)

Every check, comment and audit fix of V2 holds as it is (`MamoruActionPolicyV2.sol`, T6 and LeftClaw). V2 already checked recipients against `account` in-policy: the swap `recipient`, the policy's `mint` `recipient` (and `msg.sender` at execution), and `collect.recipient`. The UniActionPolicy `ACCOUNT` rules were therefore a second copy, and V3 grants drop them. The two live checks of an enable (observation ring, M-5 depth) run at enable time, outside setup, or at the first priced use of a config enabled in setup mode (see the common table); decrease, collect and burn never wait on them. Positions are managed through the admitted set (minted through the policy's `mint`, or named in owner-signed `Init.admit`), checked against `ownerOf(tokenId) == account`. `manage-any` therefore needs no per-position grant: the T0 `manage` grant pinned a tokenId and could never be granted at setup. Budgets (a token bucket plus a total per account and pool) and price ranges are V2's, with no change.

## ERC-4626 vaults (`FAMILY_VAULTS`)

| Check | Threat | Why it holds |
|---|---|---|
| Vault allowlist `vaultAsset[target] != 0`, constructor only | A key deposits into an attacker's vault (an ERC-4626 that takes the assets and returns worthless shares). | The list is fixed at deployment. There is no owner, setter or registry, so a compromised admin key cannot add a vault. The grant must also name the vault as an action target, which is a second, owner-signed list. A new vault means a new deployment and a renewal. |
| `deposit` / `mint`: `receiver == account` | The account's assets mint shares to the attacker. | 4626 credits shares to `receiver`, and the caller (the account) pays. |
| `withdraw` / `redeem`: `receiver == account` | The account's shares are burned and the assets sent to the attacker. | 4626 sends assets to `receiver`. |
| `withdraw` / `redeem`: `owner == account` | The account burns someone else's shares that were approved to it. | This is not theft from the account, but it would use the account as a relay for a third party's allowance. Refused so that every exit is the account's own position. |
| `approve(spender, _)` only when `target == vaultAsset[spender]` | A key approves the account's tokens to an attacker, or approves a listed vault for a token that is not its asset. | The spender must be a listed vault and the token its asset (read from `asset()` at construction). A standard vault pulls only from its caller inside `deposit`/`mint`, so the approval only feeds the checked calls above. |
| Any other selector on a vault: FAILED | Share `transfer`, `approve` of shares, or non-standard entry points (Aave's `depositATokens`, `redeemATokens`, `metaDeposit`). | Only the four 4626 calls. |

Not covered by the policy, and left to configuration and the engine:
- **Vault risk.** A listed vault that is upgraded (waBasUSDC is an upgradeable proxy) or whose curator misbehaves (MetaMorpho's markets) can lose the deposits. The policy cannot see that. The registry pins the codeHash and the implementation (#186 condition) and the engine checks liquidity before a redeem; neither is in this contract.
- **Approval amount.** It is not capped here. V2 also leaves approval amounts to the grant, and a V3-only grant has no UniActionPolicy. The exposure is a listed vault pulling more than the deposit, which a standard 4626 does not do. The engine should approve exact amounts.
- **No amount cap.** Deposits and redeems keep value in the account's own position, so there is no custody limit to enforce. The total cap model (engine-side cap, user-signed cap) is not affected.

## CCTP V2 bridge-out (`FAMILY_BRIDGE`)

The same rules as #213's `bridgeOutGrant`, decided in the policy instead of as UniActionPolicy param rules.

| Check | Threat | Why it holds |
|---|---|---|
| `target == TOKEN_MESSENGER`, selector `depositForBurn` only | A key calls `depositForBurnWithHook` (hook data runs on the destination) or another messenger. | One immutable messenger and one selector. |
| `destinationDomain == DESTINATION_DOMAIN` (Monad 15 on Base) | USDC is minted on a chain where the account does not exist or is not the same account. | Design D gives the account the same address only on the chains whose setup lists it. The domain is fixed at deployment. |
| `mintRecipient == bytes32(uint256(uint160(account)))` | USDC is minted to the attacker on the destination. | The same address on the destination is the same Safe (design D: byte-identical initializer, CREATE2). The left-aligned `bytes32(bytes20(account))` is a different recipient and is refused. |
| `burnToken == BURN_TOKEN` (USDC) | Another token is burned. | One immutable token. |
| `destinationCaller == 0` | A key pins a relayer it controls, which could stall the mint. | Open caller: anyone may relay the attestation. A pinned caller could only delay the mint, never redirect it, but it is refused anyway. |
| `maxFee == 0` | A key pays a relayer fee out of the burned amount. | No fee. |
| `minFinalityThreshold >= 2000` | Fast transfer (1000), which has a fee and different trust. | Standard only. |
| `amount != 0` | A zero burn spends usage. | Refused. |
| `approve` only of `BURN_TOKEN` to `TOKEN_MESSENGER` | An approval to anyone else. | The messenger pulls only from its caller inside `depositForBurn`. |

Not covered: the CCTP attestation itself (Circle), and the destination Safe's existence (what makes it always deployable is the T2 requirement below, "Binding requirement on T2"). Design D gives the same address, not a deployed Safe: the mint lands on the counterfactual address, and the account deploys there later with the same, frozen initializer. That deploy succeeds on any later day only if both of these hold:
- **Every contract the destination's session list names is live at the address embedded in it**: V3 for that chain, MamoruGasPolicy, TimeFramePolicy, SmartSession, the Safe stack, the chain init. For V3 this is a deployment rule, enforced by `script/DeployV3.s.sol`'s pinned init code hash and address per chain (test/DeployV3.t.sol fails on any rebuild that moves them): **V3-Monad is live at its pinned address before any Base account embeds it, and before any bridge-out grant is issued.**
- **No enable in that list reverts on state that changes after onboarding.** Measured for each piece the Monad list names (test/V3SetupFork.t.sol):
  - V3: setup mode, above. `V3CrossChainSetupFork`: Base onboards and burns 100 USDC to Monad; on Monad, 60 days later, with the WMON/USDC pool sold to the end of its curve and its observation ring short, the same Init in V2's encoding reverts on both live checks, and the Safe still deploys with the same initializer, at the same address, with its three Monad grants and the USDC. The vault and bridge inits read nothing live.
  - TimeFramePolicy (`0x8177451511dE0577b911C254E9551D981C26dc72`, runtime codehash `0xfe83529b…cd87c` on Base): its enable does not revert after `validUntil` (`test_vectorA_timeFrameEnableAfterExpiry`: deployed 400 days after onboarding with a 365-day window; the expired grant is enabled and validates nothing).
  - MamoruGasPolicy: its enable checks only the signed caps (non-zero, `maxFeePerGas >= maxPriorityFeePerGas`) and stores them per (ConfigId, multiplexer, account). No live read.
  - **ERC-7484 attestations: a real vector.** Safe7579's `installModule` calls `ModuleRegistry.checkForAccount(account, SmartSession, 1)` against the attesters the launchpad configured (traced in `test_vectorC_installModuleChecksTheRegistry`; with an attester that has attested nothing, the whole setup reverts with the registry's `0xe424f994`). If Rhinestone's attester revokes SmartSession on Monad, or its attestation expires, every not-yet-deployed account there reverts at setup, whatever V3 does.

Because the last vector is outside Mamoru's control, and new ones may appear, the destination branch is made best-effort in T2 (next section).

## Deployment

`script/DeployV3.s.sol`: CREATE2 through `ModuleRegistry.deployModule`, which also writes the ERC-7484 record. The constructor arguments for each chain are listed in that script; they differ, so Base and Monad get different V3 addresses (the registry is at the same address on both, the init code is not). The allowlist and the bridge (in `MamoruV3Routes`, created by V3's constructor) are part of the init code, so a different list gives a different address. `run()` deploys only with the pinned deployer, guardian and salt nonce, and only when the init code hash and the predicted address equal the chain's pins. Order: V3-Monad first, checked at its pinned address, then V3-Base, then grants. Nothing is mutable after deployment except the account state that owner-signed enables write, and the guardian's pause.

## Binding requirement on T2 (MamoruChainInit)

Coordinator decision (#116 T1 round 3; a permanent fund lock outranks griefing, Ot asked for top reliability):
- **The signup chain's branch stays strict**: any failure reverts the whole deployment (T0's strict `init`), so an account is never created on the chain the user signs up on without its grants, and a griefer can only waste their own gas.
- **Every non-signup branch (Monad today) is best-effort**: each SmartSession enable on it runs in try/catch, behind a `gasleft()` floor checked before the try (about the enable's own cost x 64/63 plus a margin, measured per list), so T0's griefing band (an empty setup under any limit from 1.77M to 15.34M) is closed. Because the registry check sits in `installModule` itself (vector above), the fallback must cover the install of SmartSession too, not only the enable data: the Safe then deploys without SmartSession, and the owner adds it later. The Safe always deploys at its address and the owner always controls the bridged funds; missing grants cost one tap.
- Bridge-out grants are issued only for accounts whose initializer follows this rule.

## ERC-7562

As in V2, validation reads storage outside the account (oracle, position manager, `vaultAsset` in MamoruV3Routes) and the timestamp, and writes account state in a layout that is not sender-associated (V2's `_spend`, `mapping(account => mapping(pool => …))`: slot `keccak(pool ‖ keccak(account ‖ n))`). So these ops are not public-mempool compatible, and Mamoru bundles its own userOps (spec 007 "ERC-7562"). The one write V3 adds at validation, `_pending`, is keyed pool first and account last (slot `keccak(account ‖ keccak(pool ‖ n))`), which is the associated form; it does not change the verdict, the other writes and reads above already decide it.

## Validation gas of the first priced use

A config enabled in setup mode runs the deferred checks inside the first swap, mint or increase's validation: one `slot0` read plus the M-5 tick walk, at most `bandTicks / tickSpacing + 1` steps per direction (two directions), each one a cold `ticks()` read of the pool. Measured on Base: swap validation 230k gas on first use against 101k after (WETH/USDC 0.3%, band 100, spacing 60); mint 161k on first use. The stables pool (band 10, spacing 1) walks at most 11 steps per direction. The bound for MAX_BAND (500) on a spacing-1 pool is about 1,000 cold reads, roughly 2.5M gas, still under MamoruGasPolicy's 3M `verificationGasLimit` cap but not by much: the operator must budget `verificationGasLimit` for the first priced use of each setup-mode config, and production bands (10 and 100) keep it under 0.2M.
