# T1 probe: fallback action, gas-only userOp policy, gas (spec 010, otto/mamoru#291)

Date 2026-11-02. Test: `contracts/action-policy/test/OneAuthProbeFork.t.sol` (13 tests per chain, all pass).
Run: `cd contracts/action-policy && nix shell nixpkgs#foundry --command ./install.sh` once, then
`nix shell nixpkgs#foundry --command forge test --isolate --match-path test/OneAuthProbeFork.t.sol -vv`
(`--isolate`: each top-level call is its own transaction, cold state).

Forks (public RPCs only, anvil semantics, no live chain): Base block 53,140,000 (ts 1793069347, https://mainnet.base.org);
Monad block 116,980,000 (ts 1793085513, https://rpc.monad.xyz). Foundry 1.7.1, solc 0.8.28.

Stack: SmartSession `0x00000000002B0eCfbD0496EE71e01257dA0E37DE`, code hash
`0xf2817b89...022ab0c` on both chains (equals the registry pin; the test asserts it). Safe 1.4.1 + Safe7579 with
SmartSession installed empty, owner EOA, session key via OwnableValidator. Production enable flow reproduced:
owner Safe tx `trustAttesters` + self-`attest`, then `SmartSession.enableSessions` (real registry check, no mocks).
Test policies are deployed with `ModuleRegistry.deployModule`. MamoruGasPolicy is the repo's own artifact.

## 1. Fallback action: YES

- Source: Sourcify exact match for Base (compiler 0.8.28, `contracts/SmartSession.sol`, `DataTypes.sol`, `lib/PolicyLib.sol`).
  `FALLBACK_TARGET_FLAG = address(1)`, `FALLBACK_TARGET_SELECTOR_FLAG = 0x00000001`,
  `FALLBACK_TARGET_SELECTOR_FLAG_PERMITTED_TO_CALL_SMARTSESSION = 0x00000002`,
  `FALLBACK_ACTIONID = 0xd884b6af...4d28cf` (found as a constant in the runtime bytecode). Monad has the same code hash
  (Sourcify has no entry for chain 143; the bytecode identity is the evidence).
- `PolicyLib.check` : if the call's own `(target, selector)` ActionId has no policy, it retries with `FALLBACK_ACTIONID`.
  A call whose target is SmartSession itself uses `FALLBACK_ACTIONID_SMARTSESSION_CALL` and reverts unless that is set.
- Session: one action `{actionTarget: address(1), actionTargetSelector: 0x00000001, actionPolicies: [OnePolicy]}`,
  userOpPolicies `[MamoruGasPolicy]`. OnePolicy allows only `USDC.approve`.
  - (a) `USDC.approve(router, 1e6)` userOp signed by the session key validates and executes (allowance = 1e6). handleOps gas 275,136 (Base).
  - (b) refused at validation (`AA23 reverted`; SmartSession's `PolicyViolation`, wrapped by Safe7579 as `ExecutionFailed()` 0xacfdb444):
    other target (WETH/WMON.approve), other selector (USDC.transfer), a call to SmartSession itself
    (`removeSession`), and a batch with one allowed plus one forbidden call. Same results on Monad.
- Note: enabling a fallback action with ZERO action policies does not revert at enable; the session is simply unusable (refused at validation).

## 2. userOpPolicies = [MamoruGasPolicy] only: YES, no NoPoliciesSet

- `enableSessions` succeeds and the userOp validates (Base and Monad). `NoPoliciesSet` is raised only for ACTION
  policies (`minPolicies = 1`, in the fallback path) and for ERC-1271/paymaster; userOp policies have `minPolicies = 0`.
  An EMPTY `userOpPolicies = []` also enables and validates.
- TimeFramePolicy (0x8177...dc72) on chain, `initData = abi.encodePacked(uint128 validUntil, uint128 validAfter)`:
  - `(validUntil=0, validAfter=0)` enables but every use REVERTS in `checkUserOpPolicy` with
    `0x6d3a33ce(configId, multiplexer, account)` (the policy treats an all-zero config as not initialized). Do not use it.
  - `(validUntil=0, validAfter=now-60)` returns validationData with validUntil 0: valid now AND after warping +10 years.
    So `validUntil = 0` means no upper bound on chain, provided `validAfter != 0`. Control: `validUntil = now+1d`
    is refused after +10 years (`AA22 expired or not due`).
  - Since the gas-only form works, none of this is needed.

## 3. Gas (Ethereum schedule: anvil does not reprice for Monad; same figures on both forks)

All through `Safe.execTransaction` by the owner, cold state, `vm.lastCallGas().gasTotalUsed` (tx gas incl. intrinsic of that call).
The test action policy stores one slot at init, so real V4 init cost is added on top of these.

| Operation | gasUsed |
|---|---|
| trustAttesters + self-attest 4 modules (once per account) | 764,039 |
| enableSessions: 1 fallback session, userOp [Gas] | 610,668 |
| enableSessions: 1 fallback session, userOp [] | 498,120 |
| enableSessions: 1 fallback session, userOp [TimeFrame, Gas] | 678,034 |
| enableSessions: 9-action session (v6 shape: TimeFrame+Gas, 1 policy per action) | 1,917,325 |
| enableSessions: 3-action session | 985,756 |
| removeSession, 9-action session | 358,144 |
| removeSession, 3-action session | 205,232 |
| removeSession, fallback session (1 action) | 147,520 |
| Migration tx, one MultiSend: removeSession x3 (9+9+3 actions) + enable 1 fallback session [Gas] | 1,225,363 |

`removeSession` never calls the policies, so only the action/policy counts matter; the figures hold for V3 sessions.
(The spec's 2.7M for a V3-only session is the setup-time enable of many policies with real Init work.)

Extra external view call inside `checkAction` (STATICCALL to a contract doing 6 SLOADs, all cold):
- direct `checkAction` tx: 3,227 -> 19,335 gas, i.e. +16,108.
- inside a full userOp (`handleOps`): 275,143 -> 291,262, i.e. +16,119.
- Ethereum schedule: 2,600 cold account + 6 x 2,100 cold SLOAD + overhead. Monad charges more for cold access
  (estimate from its repricing, NOT measured here: roughly 10,100 + 6 x 8,100 ~= 59k).
- ERC-7562 warning: a validation-phase read of ANOTHER contract's storage violates the unstaked-entity storage
  rules unless that storage is associated with the account (slot derived from the account address) or the entity is
  staked. The Mamoru bundler/relayer path must accept it, or the registry must lay out per-account data keyed by account.

## Blockers

None. Test policy is a stand-in; V4's own Init/check cost is not measured here.
