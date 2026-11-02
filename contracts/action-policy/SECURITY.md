# MamoruActionPolicyV4: threat model (spec 010, one authorization)

Scope: `src/MamoruActionPolicyV4.sol` (with `MamoruV4Helper`, created by V4), `src/MamoruRegistry.sol`, `src/MamoruGasPolicyV2.sol`, `src/MamoruRemoteSafe.sol` (`MamoruRemoteInit` and the initializer encoders), `src/MamoruV4Chains.sol`, `src/MamoruMigrationCheck.sol` (otto/mamoru#292). Not deployed and not audited. Results and every measured figure: `specs/010-one-authorization/results/t2-t4-contracts-2026-11-02.md`.

The account carries **one** SmartSession session per chain: a single fallback action (`FALLBACK_TARGET_FLAG`) whose only action policy is V4, and `MamoruGasPolicyV2` as its only userOp policy. The owner signs once (`InitV4`: the cap C, the generation, and for a remote Safe its home). Which pools, vaults and chain routes the engine may use comes from `MamoruRegistry`, timelocked. Everything that could send value elsewhere (router, position manager, messenger, tokens, Safe stack, the remote's shape) is a V4 constant.

Adversaries: a leaked **session key** (or a misbehaving operator); a leaked **registry admin** (both keys of the team Safe); a leaked **guardian**; combinations. Not covered: anything the owner signs (withdrawals, Stop, rotations, migrations), Circle (CCTP, USDC), Uniswap, Safe, Rhinestone's code as deployed, and a MetaMorpho curator's conduct inside the vault's share of the bucket.

## I1: funds land only in the owner's Safes; approvals only to V4

| Check | Threat | Why it holds |
|---|---|---|
| `checkAction` admits only: V4's `swap`, `mint`, `increase`, `deposit`, `redeem`, `bridge`, `registerRemote`; `approve(V4, x)` on any target but the position manager; the position manager's `decreaseLiquidity`, `collect`, `burn` of admitted positions. Everything else returns FAILED. | A key approves the router, a vault, the messenger or itself, calls them directly, transfers, withdraws the EntryPoint deposit, calls the Safe itself. | The fallback action sends every call of every session op through `checkAction` (T1). Tested at validation through the real stack (`V4UserOpFork`, `AA23` for each) and directly (`test_I1_checkActionAdmitsOnlyV4AndExits`). SmartSession itself refuses empty batches and calls to SmartSession. |
| Each V4 spending function pulls the exact amount from `msg.sender`, approves the pinned counterparty for exactly that amount, acts with the account as recipient, resets the allowance to 0 and returns any rest (balance delta). | The counterparty pulls more, or an allowance lingers on the router / manager / vault / messenger. | Test asserts allowances back to 0 and nothing left in V4 after every action. |
| V4 only ever pulls from `msg.sender`, inside its own functions, under `nonReentrant`. | A leftover allowance on V4 (even unlimited) is used by someone else. | No V4 function takes a `from`. `test_I1_leftoverAllowanceIsInert`. |
| Every check of V3's swap / mint / increase / vault / bridge paths runs at **execution**, inside V4's function, with the account as `msg.sender`. | A check at validation and an action at execution see different states (V3's LeftClaw M-2 window). | There is no window; a failing check reverts the action (nothing charged, nothing moved; the op's gas is still charged to the gas bucket). |
| `data.length >= 4`; native value only in `deposit()` (exactly 4 bytes, value > 0) on the chain's pinned wrapped native (`MamoruV4Chains.wrapped`: WETH on Base and Ethereum, WMON on Monad); `withdraw(uint256)` there only with value 0 (#307). | Native value leaves; an action-free op. | WETH9 credits `deposit` to, and pays `withdraw` back to, `msg.sender`: the account. Value never leaves it, so neither is charged. Value to any other target, or with any other selector on the wrapped native (`approve`, `transfer`), is FAILED (`test_checkAction_nativeValueOnlyToWrap`, and through the EntryPoint `test_sibling_valueElsewhereRefused`). The unwrap's 2,300-gas transfer reaches the Safe proxy, warm inside its own execution (`test_sibling_unwrapBackToTheAccount`). Residual: a leaked key can wrap the account's gas reserve (a stall, no loss; the session or the owner unwraps). |
| The session cannot sign for the account. | A leaked key signs a `permit` / Permit2 order. | The V4 session has no ERC-1271 policy; SmartSession refuses (`test_sessionKeyCannotSignForTheAccount`). |

## Pinned in V4 (r1 P0, r2 P1)

| Check | Threat | Why it holds |
|---|---|---|
| Per-chain tuple in code (`MamoruV4Chains`, keyed by `block.chainid`): Uniswap factory, position manager, SwapRouter02, pinned stables (USDC, USDT on Base; USDC on Monad), pinned assets (WETH, cbBTC; WMON; WETH), the wrapped native, MetaMorpho factories (Base), CCTP domain. Base, Monad and Ethereum (#307: Uniswap v3 factory, NPM and SwapRouter02 read back on chain, USDC only, since USDT's CCTP burn limit is 0 there, no vault factory; domain 0). CCTP domain 0 is Ethereum, never a "none" sentinel: `MamoruV4Chains.chainOf`. | The registry names a router, a manager, a messenger, a token, a "stable". | The registry has no such entries. A pool must be `factory.getPool(token0, token1, fee) == pool` of two pinned tokens, one a pinned stable (the budget unit); a stable pair must carry the parity anchor. Tests: non-pinned EURC pool refused, the router or messenger listed as a "pool"/"vault" refused, a route to an unpinned domain refused. A chain outside the table refuses every enable and every validation. |
| Safe stack code hashes at every enable (singleton, factory, MultiSend, Safe7579, launchpad, shared signer, SmartSession, OwnableValidator, messenger proxy). | A chain where the canonical address runs different code. | `BadStack` (tested by etching one). |
| CCTP burn token: a pinned stable that the canonical messenger's own `localMinter().burnLimitsPerMessage(token) > 0`. | A burn of anything else. | |
| V4, its helper, `MamoruRemoteInit`, the gas policy and the registry are CREATE2 with chain-independent init code; the runtime code reads the chain only at call time. | "The same address" means different code on another chain. | Deterministic deployer, same salts and arguments on both forks give the same addresses (`V4RemoteFork` setUp asserts it). |

## I2: price and depth

V3's two-TWAP range, anchor, swap bounds (minOut and limit at the range edge, limit strictly past the spot), mint/increase minimums at the spot, decrease minimums without the anchor (M-6): unchanged, in `MamoruV4Helper`, run at execution. Parameters come from the registry entry and are **refused** (never clamped) outside V3's hard bounds, by the registry at queue and by V4 at use (`test_M1_entriesOutsideTheHardBoundsAreRefusedByV4`). At every priced use, LeftClaw M-5's in-band depth must cover `DEPTH_MULTIPLE` (20) times the call's value. The tick walk is capped at 64 steps per direction, which can only under-count the depth (refuse more). A thin pool queued by a compromised admin, live after 72 h, is refused for any call of meaningful size (`test_trapThinPoolAfterDelayRefused`). The observation ring must cover the long window at every use (T6 L-4).

## I3: positions

As V3: only positions minted through V4 or admitted in an owner-signed Init, still owned by the account. The account-wide Init revokes a position for good (M-4). A position in a pool the registry removed is exit-only: decrease, collect, burn priced by the removed entry's kept parameters; no increase (I8).

## I4: the remote Safe

| Check | Threat | Why it holds |
|---|---|---|
| `remoteOf` is computed by V4 (`MamoruV4Helper.remote`) from the account's **current** owners, threshold and passkey (x, y, verifiers), the domain, the session key, and V4's own canonical initializer. Salt `keccak(account, domain, ownersHash)`. `registerRemote` acts on `msg.sender` only. | A key names another account's state, or a revoked key is carried into a new remote (r2 P0). | Nothing but the session key is caller-supplied. `test_I4_registerRemoteWithAnotherAccountsStateRefused`. |
| The initializer: plain `Safe.setup` (owners, threshold, the shared signer's `configure`), then `MamoruRemoteInit` (enable Safe7579, initialize it with SmartSession as the only validator, ERC-7484 registry **off**), SmartSession in UNSAFE_ENABLE with one fallback session bound to V4 (`InitV4{C, 1, home, homeDomain}`) and the gas policy with the destination's pinned caps. | The remote cannot be deployed after funds were minted to it (r2 P0-1). | Deployment reads only code and immutable state. **Deviation from the spec's self-attestation**: an attestation goes through ModuleRegistry's resolver for SmartSession's record, which the Rhinestone attester can repoint (`setResolver`); T1b does it on a fork and the self-attested setup reverts, while this one deploys. It deploys 400 days later too. |
| `bridge` from a home account: the registry routes the domain, the guardian marked the registered remote ready for the same owners hash, and the account's owners hash is still that one. | A burn to an address nobody verified deployable and correct (r4 P0); a burn during a rotation (r3 P0-1). | Only the guardian writes readiness, after reading the remote back on its chain. Any owner change makes `isReady` false and refuses every burn until re-registration and a new read-back. A new registration starts unready. Tests: refused before readiness, after an owner swap, after the route's removal. |
| `bridge` from a remote Safe: only to its `home`, on its `homeDomain`. | A remote's funds go anywhere else. | Bridge-back needs no route and no readiness, so an exit always works. |
| A remote cannot register remotes. | Chains multiply past MAX_CHAINS. | `BadBridge(4)`. |
| **Sibling** (#307): an Init whose `home` is the account itself, on another domain of the table. It is the account's own address on a chain where the owner holds funds at the home account's address (Guillermo's ETH on Ethereum, #117). Same SafeProxyFactory, same CREATE2 address, so the same initializer and the same initial owners. Before #307, `home == account` was `BadInit(4)`: a canonical remote never has its home's address, so it could only be a mistake. | Funds burn to an address on the home chain that is not the user's. | A sibling bridges **only** to its home domain, and only once the guardian marked it ready (`setReady(account, homeDomain, account)`, after reading back on the home chain that the address is the user's Mamoru account: deployed with these owners, or counterfactual from the account's recorded initializer). Readiness is bound to the sibling's current owners hash: any owner change refuses every burn until a new read-back (`test_sibling_readinessRules`). A sibling has no remotes (`BadBridge(4)`), and its home domain must be another chain of the table (`BadInit(4)`). The Init is owner-signed like every other: a sibling of an address the owner does not hold elsewhere can only be signed by that owner. |

Residual (accepted in the spec): a compromised (not lost) passkey controls every remote until rotated there; the guardian is trusted to read a remote back before `setReady` (a compromised guardian alone moves no funds: it can only mark V4's own computed address); a leaked session key can choose the remote's session key (bounded by V4 on the remote) and can keep re-registering to clear readiness (griefing).

## I5: the account's budget per chain

| Limit | Mechanism | Crossing call |
|---|---|---|
| Account bucket | Token bucket of capacity C, refilled C per day. | Reverts `BudgetExceeded(0)`. |
| Per pool / per vault | Token bucket of `ratioBps x C`, same refill; a capacity change settles the refill at the old rate first, then clamps (LeftClaw M-3). | Reverts `BudgetExceeded(key)`. |
| Rolling 30 days | Sum over 31 daily periods (covers at least the last 30 days) <= 3C. | Reverts `Cap30Exceeded`. |
| Circuit breaker | Sum over 25 hourly periods (covers at least the last 24 h) <= C. | Not executed; V4 pauses the account (`PAUSE_BREAKER`) until the guardian unpauses. |
| Review threshold | Spend since the guardian's last `review` <= 10C. | Not executed; V4 pauses (`PAUSE_REVIEW`) until the guardian reviews. |

Charged: swaps (amountIn at the range edge that values it highest), mints and increases (desired amounts, same valuation), vault deposits (assets). Not charged: decrease, collect, burn (the band bounds their price), redeem (value returns to the account), bridge (value stays the user's, bounded by V4 on the other chain). Because the breaker never lets the crossing call execute, the stated bounds are hard: C per 24 h, 3C per 30 days, 10C between reviews, per chain, times at most MAX_CHAINS (4) chains per account.

**Vaults: what is at risk is capped, not only the deposit rate** (review r1 of #200, P1). A vault entry's ratio is at most `MAX_VAULT_RATIO_BPS` (5,000: half of C), in the registry and in V4. At every deposit, the account's current position in the vault, by the vault's own accounting rounded against the depositor (`previewMint` of its shares), plus the deposit must stay within `ratioBps x C`. So the funds at risk in one listed vault are at most `ratioBps x C <= C/2` per chain, however the deposits are spaced (`test_hostileCuratorVaultExposureCapped`: a hostile curator's own factory vault, four attempts over 96 days, 0.5C held). Residual: the cap reads the vault's accounting, so after a vault reports a loss the account may deposit up to the cap again; each such refill is still bounded by the bucket, the breaker, the 30-day cap and the review threshold, and ops removes a vault that reports a loss (removal is immediate).

## I6: gas (`MamoruGasPolicyV2`)

V1's per-op caps, plus a per-account bucket per window and a cumulative `GAS_REVIEW` (0.01 ETH on Base, 5 MON on Monad, 0.03 ETH on Ethereum, 0 elsewhere: fail closed). Each op is charged at validation from its own capped fields, `(call + verification + preVerification + paymaster limits) x maxFeePerGas`, the EntryPoint prefund; an op that would cross either is rejected. Only SmartSession can charge (V1 let any caller write its own slot; V2's per-account state forbids it). Measured through the EntryPoint: at the caps, 3 griefing ops per day, 19 in total, then every op refused until the guardian reviews; the Safe paid 0.00053 ETH for them (the charge, 0.00988 ETH, is the prefund bound).

## I7, I8: guardian and registry

Guardian: `pause`, `unpause`, `review` (V4 and the gas policy), `setReady` / `clearReady` (I4), and `cancel` on the registry. It cannot enable, widen, list or move anything. Registry admin (the team Safe, 2 of 2): `queue` and `execute` additions and loosenings after an immutable `DELAY` (>= 48 h, 72 h in production), each public (`Queued` with its parameters); immediate `remove*` and `tighten*`. Admin, guardian and delay are constructor arguments that must be identical on every chain (same init code, same address).

## Threat model, worst case per chain (C = the owner's cap)

| Who | Bound | Measured |
|---|---|---|
| Leaked session key | Swaps and positions: the whole permitted spend, C per 24 h, 3C per 30 days, 10C per review, per chain. One listed vault: the funds at risk in it are at most `ratioBps x C <= C/2` at any time (live position cap), with refills after a reported loss inside the spend limits. | Single-block sandwich on WETH/USDC 0.3 % with the registry at its loosest (band 500, ratio 10,000): **5.0 % of C per day** (501 bps; 10,000 USDC cap, 9,498 charged, 501.55 lost), stopped by the bucket. Anyone can create a MetaMorpho vault through the pinned factory; once listed (72 h in public), a hostile curator holds at most **C/2** of the account per chain (`test_hostileCuratorVaultExposureCapped`). |
| Leaked session key, gas | Gas bucket per window, then GAS_REVIEW per chain. | Above. |
| Leaked registry admin | Each addition waits 72 h in public; guardian cancels. Then the session-key bound. Cannot name a token, router, manager, messenger, Safe stack or remote. | Router/messenger/NPM entries and an EURC pool refused; a thin trap pool refused by depth. |
| Admin + session key | Same as the session key. | |
| Leaked guardian | Pause, unpause, clear the review counters, cancel queued entries, mark V4's own computed remote ready. No funds move. | |
| Compromised operator | Within I1-I6; withdrawal stays owner-only. | |
| Ethereum (#307) | The same per-chain bounds on Ethereum's own C. One more chain per account at most: the table has three (Base, Monad, Ethereum), inside `MAX_CHAINS` (4). A sibling's funds leave only to its own address on the home chain, after the guardian's read-back. | `V4EthereumSiblingFork`: one owner signature (UNSAFE_ENABLE, no attestation on a Safe set up before V4), then wrap, swap on USDC/WETH 0.05 % and burn home with no signature. |

## Migration (v2-v6 -> V4)

One owner Safe transaction: `removeSession` for every old id; `revokeEnableSignature` for every old id; self-attest V4 and the gas policy; enable the V4 session (positions admitted in its Init); then `MamoruMigrationCheck.assertMigrated(account, [v4 id], oldIds, noncesBefore)`. The check reverts unless:
- the V4 session is the only one enabled, read from SmartSession's own `getPermissionIDs` (`assertOnly`);
- every old id's ENABLE nonce (`getNonce`) moved past the value the operator read when building the transaction.

On a revert the Safe reverts the whole transaction (GS013).

Why the revocation (review r1 of #200, P1): `removeSession` does not touch `$signerNonce[id][account]`, over which SmartSession verifies an owner-signed ENABLE payload. An unused payload from a v2-v6 renewal would otherwise re-enable the old session after the migration, outside V4. The fork test shows exactly that on the first version of the migration (`test_enableReplayReEnablesAnOldSessionWithoutRevocation`), and shows it refused after the fix (`test_enableReplayRefusedAfterMigration`). `assertNone(account, ids)` remains as the spec's narrower check.

**Rule (review r2 of #200, P1): Mamoru never asks the passkey to sign a SmartSession ENABLE payload.** Owner signatures are Safe transaction hashes only (`enableSessions` inside `execTransaction`; a remote's session is committed in its Safe setup), and an ENABLE digest is a different EIP-712 hash, so no other owner signature can stand in for one. The set of signed-but-unused ENABLE payloads is therefore empty, and an old id the migration's list misses carries none. `packages/account/sessions/no-enable-mode.test.ts` fails if any production file under `apps/` or `packages/` (test code and `packages/scenarios` exempt) builds the ENABLE mode or an enable digest. Any future multichain-enable design (#230) must revoke by nonce and get its own security review before that guard is relaxed. Residual covered on chain: an old id that is still *enabled* but missing from the list is caught by `assertMigrated`'s "the V4 session is the only one enabled". Measured: 1.73M gas for a v6-shaped account (9 + 9 + 3 actions).

## ERC-7562

V4's validation reads the registry, the pool oracle and the position manager (exits only), and the gas policy writes per-account state at validation, so these ops are not public-mempool compatible; Mamoru bundles its own userOps (spec 007). The gas policy's mappings have the account as last key (associated storage), as do V4's binding, generation and pause; `admittedPool` (exits only) is keyed account first.

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
