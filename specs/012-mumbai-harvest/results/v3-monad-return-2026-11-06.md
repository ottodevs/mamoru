# V3 Monad return check (HT9, HRV-S14), 2026-11-06

Ticket: otto/mamoru#107. Read-only. No transaction sent, no state written.

## Question

Do the live accounts' Monad remote Safes carry a session grant that allows a CCTP bridge-out Monad to Base?

## Method

1. Code: `liveWmonUsdcMonadV6` (`packages/policy/src/policies-monad.ts`) has `session.grants = [manageAnyV3Only(growth pool)]`. Its `session.caps` are the two budget formulas only. No `bridgeOutGrant` is in it. `bridgeOutGrant` is used by `policies-v6.ts` (the Base side, destination Monad), not by the Monad policy.
2. Operator state (`accounts.json`, read only): every active account with `remote` has `remote.spec.policyId = live-wmon-usdc-monad-v6`, `remote.chainId = 143`, `remote.ready = true`, and exactly one entry in `remote.permissionIds`. One policy grant, one permissionId: there is no second session.
3. Chain: `SmartSession.isPermissionEnabled(permissionId, remoteSafe)` on Monad (chain 143, public RPC) for each permissionId. All return `true`: the one session exists and is enabled, and it is the manage-any one.

## Result

| Account (8) | Policy (remote spec) | Remote Safe (Monad) | Spec cap (USDC) | permissionIds | enabled on chain | Bridge-out on Monad |
|---|---|---|---|---|---|---|
| 8b0b4d7f | live-wmon-usdc-monad-v6 | 0xADd47283E643aB15e1a3E200e4c51427964937Ed | 500 | 1 | yes | no |
| c23e94e1 | live-wmon-usdc-monad-v6 | 0x72040771fbc32cA01ab97318a5125fd406e0400E | 500 | 1 | yes | no |
| c9d4179b | live-wmon-usdc-monad-v6 | 0x25E128d5BF622586890C50207104BA05311174c4 | 500 | 1 | yes | no |
| 00a7a1df | live-wmon-usdc-monad-v6 | 0x86Cf74161651096b1D4B103230eC1dD4Ca3EdF9F | 500 | 1 | yes | no |
| b54dda3a | live-wmon-usdc-monad-v6 | 0xD72A7cB9773Dc58a9B944f9737996F45dBD1F108 | 500 | 1 | yes | no |
| b22428c7 | live-wmon-usdc-monad-v6 | 0x9aB701b0b1c73B82e3d810195CC292607b8EA0E8 | 500 | 1 | yes | no |
| 307146b5 | live-wmon-usdc-monad-v6 | 0x8654FA14122595f2960Cf0Bf1cC28a2750AFDA49 | 500 | 1 | yes | no |
| 88264d2f | live-wmon-usdc-monad-v6 | 0x71F5E94eF0A65F2354A59DB086D34b0F71E26f12 | 500 | 1 | yes | no |

All eight Base accounts run `conservador-live-v7`. Their remote specs are signed with `validUntil` in 2027 (1825064387 to 1825521757, unix s), so none has expired.

## Verdict

No live V3 account has a bridge-out grant on Monad. Do not build the V3 return branch: every one of them needs a renewal (the owner signs a session that includes a Monad bridge-out grant) before idle USDC on Monad can return. Per plan R4, these accounts take `DECIDE_WAIT_RENEWAL` and are listed in #107 as "needs a renewal" with this read as the evidence. A session cannot be added without the owner's signature (PRD 5.1, no contract change).

The V4 path (`askReturn`) is unaffected.
