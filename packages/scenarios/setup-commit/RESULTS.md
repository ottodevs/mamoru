# otto/mamoru#116 T0: fork measurements for design D

Spike. Prototype `src/MamoruChainInit.sol` and scenario `t0-fork.ts` are throwaway and not audited. Run 3: 27 Oct 2026, anvil 1.7.1.
Base fork: block 53,140,000, lab chain id 31337. Monad fork: block 116,980,000, lab chain id 314143. Both forks used anvil's Ethereum gas schedule.

## Setup under test

`Safe.setup` makes a MultiSend 1.4.1 delegatecall with three entries:
- the launchpad `addSafe7579` with **no** validators;
- `SafeWebAuthnSharedSigner.configure`;
- `MamoruChainInit.init([(chainId, abi.encode(Session[]))...])`.

`init` runs in the Safe's context and calls `installModule(1, SmartSession, 0x02 ‖ sessions)` on the Safe itself.

The deploy goes through `SafeProxyFactory_141.createProxyWithNonce`. MamoruChainInit was deployed at the same CREATE2 address on both forks. MamoruGasPolicy and MamoruActionPolicyV2 were deployed on the Base fork with the repo's forge scripts.

## a–d

| | result |
|---|---|
| (a) installModule from inside setup (Safe7579 v1.0.0 + launchpad as today) | **yes**: `onlyEntryPointOrSelf` passes (the Safe calls itself), and Safe7579 is enabled as a module |
| (b) SmartSession `UNSAFE_ENABLE` in `onInstall` enables the sessions | **yes**: Base 9/9 V3-shaped, Monad 2/2. No `trustAttesters` or self-attest call was needed, because UNSAFE_ENABLE skips the ERC-7484 policy check |
| (c) same initializer gives the same address, and each chain gets only its own sessions | **yes**: `0x2666…68DC` on both forks and as predicted. Base holds 0 of Monad's sessions; Monad holds 0 of Base's |
| (d) unlisted chain id (31338) with the same initializer | **yes**: deploy succeeds at the same address with SmartSession installed and empty (`isInitialized` false). Gas 979,433 |

## Gas (receipt gasUsed, Base fork, Base list only unless noted)

| initializer | n | gasUsed | calldata |
|---|---|---|---|
| v1 today (launchpad installs SmartSession empty) | 0 | 537,056 | 1.4 KB |
| v2, chain not listed | 0 | 671,774 | 24 KB |
| v2, v5 set (UniActionPolicy + V2 + gas, TimeFrame, UsageLimit) | 1 / 3 / 9 | 2,899,475 / 9,694,368 / **28,941,594** | 15 / 65 / 193 KB |
| v2, V3-shaped (V2 only per action; TimeFrame + gas policy) | 1 / 3 / 9 | 1,864,624 / 4,782,010 / **13,053,503** | 5 / 16 / 44 KB |
| v2, V3-shaped 9 + Monad list in the same initializer | 9 | 13,194,007 | 67 KB |
| same initializer on Monad (2 Monad sessions: UniActionPolicy, TimeFrame, UsageLimit) | 2 | 4,200,776 | 67 KB |

What a session costs:
- v5: about 3.1M on average. A 3-action grant costs about 2.3M and a 9-action manage-any about 4.4M.
- V3-shaped: about 1.37M on average (1.2–1.6M).
- Monad (UniActionPolicy): about 1.75M.

Calldata intrinsic gas is about 0.64M for the 9 V3-shaped sessions and 0.88M once the Monad list is added (the EIP-7623 floor binds).

Caps:
- **Base (2^24 = 16,777,216 per tx):** v5 ×9 does not fit (28.9M). v5 fits only up to 3 sessions. V3-shaped ×9 fits, but tightly (see the next section).
- **Monad:** the fork reports a block gasLimit of 150,000,000, and `eth_estimateGas` on the public RPC accepts up to 150M. I could not read a per-tx cap over RPC. Monad charges the gas **limit**, not the gas used.

## Gas limit vs gasUsed, and griefing (gas sweep on `createProxyWithNonce`)

V3-shaped ×9, strict `init`, 53 gas limits from 0.64M to 18.3M:
- below **15,338,113** every limit reverted;
- from 15,338,113 up every limit gave a fully configured Safe;
- no limit gave a half-configured Safe.

The tx needs a gas **limit** of 15.34M while it uses 13.05M: EIP-150 holds back 1/64 at every nested call. That leaves only 1.44M of headroom under Base's 2^24.

Try/catch `initOrEmpty` with no gas floor, 77 limits:
- below **1,765,466**: reverted;
- **1,765,466 – 15,338,235**: the deploy succeeds with an **empty SmartSession**. This is a silent fallback: a griefer who front-runs with a limit in this band leaves the account without grants, and the owner needs one more tap. Since the address is fixed, nobody can redeploy it.
- from **15,338,389** up: fully configured.

There was no partial state in any probe. Every frame between the factory and `SmartSession.onInstall` checks success:
- the factory reverts if the initializer call fails;
- `setup` reverts with GS000;
- MultiSend reverts;
- Safe7579's `_delegatecall` reverts with `ExecutionFailed`.

The only try/catch is the one in `initOrEmpty`.

So the try/catch fallback is griefable over almost the whole gas range unless it has a gasleft floor. A floor of about (enable cost × 64/63 + margin) should close that band, but the floored sweep was **not run** (stopped for time). The strict variant has no griefing band: a griefer can only make the deploy revert, which wastes their own gas.

## Grants with ACCOUNT param rules (static, every current policy)

Every grant of every live policy pins a recipient to `ACCOUNT`, so all of them have to move that check into the Mamoru policy:
- `enter-swap`: `SwapRouter02.exactInputSingle.recipient`. All policies, v1 to v5 and Monad.
- `enter-mint`: `NonfungiblePositionManager.mint.recipient`. All policies.
- `manage-any`: `collect.recipient` and `mint.recipient` (live-v1/v2, guards, geometry, v4, v5), plus `exactInputSingle.recipient` (v4, v5).
- `manage`: `collect.recipient` and `exactInputSingle.recipient` (v1, lab-v1, lab-weth-usdc, live-wmon-usdc-monad). This grant is also per-position (it needs a tokenId), so it cannot be granted at setup at all.
- `convert-any`: `collect.recipient` and `exactInputSingle.recipient` (live-v1/v2, guards, geometry).

The measurement used a placeholder account (`0x…aa`) for these refs. Their gas cost would be the same.

## Not measured / caveats

- The try/catch sweep **with** a gas floor, and a sweep of the v5 3-session set.
- Real Monad gas: anvil uses Ethereum's schedule and Monad reprices cold state access, so the Monad numbers are only indicative. Monad's per-tx cap is unverified.
- `MamoruActionPolicyV3` does not exist yet, so V2 stood in for it. V3's 4626 and CCTP checks will change the per-session cost.
- No userOp was run with a setup-enabled session. Only `isPermissionEnabled` was checked.
- Real chain ids (8453/143) were not used: the lab ids were, and so was the passkey owner with dummy coordinates.
- The v5 activation as it runs today (a Safe tx after deploy) was not re-measured here. The operator's figure is 1.4–2.1M per session.
