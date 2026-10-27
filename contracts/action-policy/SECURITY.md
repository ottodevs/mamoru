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
| Setup mode (`abi.encode(3, Init)`): the enable reads no live market state | A frozen setup initializer becomes undeployable on a chain where bridged funds already wait at its address (review P1 of #158). | Outside setup, a Uniswap enable reads the pool's observation ring (T6 L-4) and its in-band depth (LeftClaw M-5), both of which the market can change. In setup mode those reads move to the config's first swap, mint or increase (`_liveChecks`); until they pass, those actions are refused and nothing else changes. `admit` must be empty (`BadInit(13)`), because admission reads the position manager. What the enable still reads is the pool's identity (token0, token1, fee, the factory's mapping), which is immutable once the pool exists. The mode cannot be spoofed into a weakening: only SmartSession reaches the init, with owner-authorized data, and the mode moves the two checks, it never removes them. |

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

Not covered: the CCTP attestation itself (Circle), and the destination Safe's existence. Design D gives the same address, not a deployed Safe: the mint lands on the counterfactual address, and the account deploys there later with the same, frozen initializer. That deploy succeeds on any later day only if both of these hold:
- **Every contract the destination's session list names is live at the address embedded in it**: V3 for that chain, MamoruGasPolicy, TimeFramePolicy, SmartSession, the Safe stack, the chain init. For V3 this is a deployment rule, enforced by `script/DeployV3.s.sol`'s pinned init code hash and address per chain (test/DeployV3.t.sol fails on any rebuild that moves them): **V3-Monad is live at its pinned address before any Base account embeds it, and before any bridge-out grant is issued.**
- **No enable in that list reads live market state**: V3's Uniswap grants committed at setup use setup mode, and the vault and bridge inits read nothing live. test/V3SetupFork.t.sol `V3CrossChainSetupFork` proves it on forks: Base onboards and burns 100 USDC to Monad; on Monad, 60 days later, with the WMON/USDC pool sold to the end of its curve and its observation ring short, the same Init in V2's encoding reverts on both live checks, and the Safe still deploys with the same initializer, at the same address, with its three Monad grants and the USDC. TimeFramePolicy and MamoruGasPolicy are not this contract: they passed in that test (60 days later), but whether TimeFramePolicy's enable accepts a window that has already ended was not checked. **No amount cap**: the bridge moves value from the account to the same account on another chain. The cross-chain total cap lives in the engine and in the user-signed cap (#201), and V3 adds none on purpose so as not to conflict with it. If an on-chain per-call or total cap is wanted, it goes back into the grant as UniActionPolicy param rules, which costs enable gas.

## Deployment

`script/DeployV3.s.sol`: CREATE2 through `ModuleRegistry.deployModule`, which also writes the ERC-7484 record. The constructor arguments for each chain are listed in that script; they differ, so Base and Monad get different V3 addresses (the registry is at the same address on both, the init code is not). The allowlist and the bridge (in `MamoruV3Routes`, created by V3's constructor) are part of the init code, so a different list gives a different address. `run()` deploys only with the pinned deployer, guardian and salt nonce, and only when the init code hash and the predicted address equal the chain's pins. Order: V3-Monad first, checked at its pinned address, then V3-Base, then grants. Nothing is mutable after deployment except the account state that owner-signed enables write, and the guardian's pause.

## ERC-7562

As in V2, validation reads storage outside the account (oracle, position manager, `vaultAsset`) and the timestamp, so these ops are not public-mempool compatible. Mamoru bundles its own userOps.
