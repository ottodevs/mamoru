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
