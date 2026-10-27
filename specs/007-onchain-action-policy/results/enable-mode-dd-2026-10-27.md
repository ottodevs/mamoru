# One passkey prompt per approval: second-pass due diligence (otto/mamoru#225, 2026-10-27)

Branch `spike/225-dd`, on top of the first spike (85f8190, `enable-mode-spike-2026-10-27.md`). Local anvil fork of
Base only (block 51,811,000, anvil 1.7.1 from `~/.foundry/bin`), nothing broadcast elsewhere, no live operator, D1 or
grant touched. Script: `packages/scenarios/action-policy/t10-enable-gas-dd-fork.ts` (run line at its top). Raw output:
`raw/t10-enable-gas-dd-2026-10-27.json`. Every check passed.

## Recommendation (ranked)

1. **Build now: merge each pool's three grants into ONE session (3 sessions, 27 actions instead of 9 and 45), and
   approve the whole set in ONE ordinary owner transaction.** Measured: the full set is 10.49M gas. Moving a
   9-session v5 account to it (removeSession x9 plus enableSessions x3, one Safe tx) is 11.75M. A renewal (revoke 3,
   enable 3) is 11.33M. A contract move adds about 0.43M for the self-attestation. Every case is under the operator's
   14.5M target and Base's 2^24 cap.
   - Result: **one passkey prompt** for activation, renewal, extend and V1→V2-style moves on Base, with no ENABLE mode.
   - None of the first spike's caveats apply: no gas-cap change, no engine pending state, no precheck change, no
     `revokeEnableSignature` on stop, no eager no-op enables, and no validation-phase storage reads.
   - The relayer keeps paying, as today, and pays less: 11.3M per renewal instead of 26.2M.
   - The same audited modules are used. Nothing new is deployed.
2. **Build now, with a focused review: drop UniActionPolicy where V2 already enforces more** (decrease, collect, burn
   and the swap deadline; in pool3 this is already done). Optionally drop it everywhere (pool3v2): the full set then
   costs 6.21M and swap ops are 9-13% cheaper. The trade-off is in "Security" below.
3. **Later, only if Base and Monad must share one ceremony:** ENABLE mode, signed through Rhinestone's
   `WebAuthnValidator` installed as an ERC-7579 validator on both chains. One assertion over the multichain digest is
   then valid on both chains. It needs ENABLE mode back (with the pool3 set, the enabling op needs 4.6M of validation
   gas, or 2.43M with pool3v2), the install on each chain, and accepting a second, domain-less signing path for the
   passkey (see Q3). Until then, Monad gets its own prompt in the same dialog. That is 2 ceremonies for a user active on
   both chains, against 4-5 today.
4. **Later, a contract change (needs an audit): a pool-agnostic policy.** V2 resolves the pool from calldata
   (factory.getPool(tokens, fee)) instead of a per-ConfigId binding. Then ONE session of about 9 actions covers every
   pool. Estimate: 2.2-3.6M for the whole account. This would also let a new pool be added without a new session.

## Q1: why enabling costs what it costs

Owner path, `SmartSession.enableSessions`, one session per Safe tx, passkey-signed. In the table below:
- **Self gas** is a `callTracer` frame's gasUsed minus its children's, summed over the set.
- **Slots** are storage slots changed (`prestateTracer`, diffMode).
- **"Safe" self gas** includes the tx's intrinsic and calldata gas, the Safe's hashing and MultiSend's copy.

| | base (today, 9 sessions) | slim9 | pool3 | pool3v2 |
|---|---|---|---|---|
| Sessions / actions / actions with UniActionPolicy | 9 / 45 / 45 | 9 / 45 / 30 | 3 / 27 / 15 | 3 / 27 / 0 |
| Total gas, one session per tx | **26.80M** (595k/action) | 23.79M | 10.75M | 6.48M |
| Whole set in ONE owner tx | does not fit (reverts) | does not fit | **10.49M** | **6.21M** |
| SmartSession self gas / slots | 11.73M / 477 | 10.94M / 447 | 5.35M / 219 | 4.56M / 189 |
| UniActionPolicy self gas / slots | 7.96M / 288 | 6.41M / 237 | 2.79M / 102 | 0 |
| Safe (calldata, hashing, MultiSend) | 3.34M | 2.69M | 1.24M | 0.59M |
| MamoruActionPolicyV2 | 2.06M / 62 | 2.06M | 0.90M / 27 | 0.90M / 27 |
| ERC-7484 registry checks | 0.46M (126 calls) | 0.44M | 0.18M | 0.15M |
| Uniswap pool reads (V2 `_poolInfo` / `_depthIn`) | 0.45M | 0.45M | 0.02M | 0.02M |
| Time + Usage + Gas policies | 0.68M (27 slots) | 0.68M | 0.23M | 0.23M |
| Policy initData per set | 98 KB | 85 KB | 60 KB | 13 KB |

Per action, with UniActionPolicy:

| Cost | Gas | What it is |
|---|---|---|
| SmartSession bookkeeping | about 260k (10.6 slots) | ConfigLib.enable adds each policy to `actionPolicies[actionId].policyList[pid]` (an associated EnumerableSet of 3 slots), plus the actionId to `enabledActionIds` (3 slots). With 2 policies per action that is 9 slots, about 200k. |
| UniActionPolicy | about 177k (6.4 slots) | `fill` writes 2 + 4n slots per action (4 per ParamRule: packed header, ref, limit, used). |
| Calldata and hashing | about 74k | initData is a fixed `tuple[16]` ABI, **3,136 bytes per action whatever the rule count**. "Compact initData" is impossible with this policy. |
| V2 Init | about 46k | Binding plus the config hash check; the pool config is written once per pool and generation. |
| ERC-7484 registry check | about 10k | Run once per policy per action. Only **1.7%** of the total, so UNSAFE_ENABLE is not worth its signed `ignoreSecurityAttestations`. |

Levers, ranked by measured effect:
- **Fewer actions.** SmartSession's bookkeeping is per action and cannot be shared. Merging per pool removes 18
  duplicate actions (the approves, swap, mint and deadline that repeat across enter-swap, enter-mint and manage-any).
- **Fewer UniActionPolicy instances.** Each one costs about 200k (its slots plus one more set entry).
- **Shared configs do not exist in v1.0.0.** The ConfigId is derived from (permissionId, actionId) (`SmartSessionBase`
  / ConfigLib), so policies cannot share a config across sessions or actions without a policy-side change.

## Q1 (cont.): ENABLE mode and per-op gas for each variant

Same snapshot. One passkey signature over the set (`isValidSignature` 74k, 21k intrinsic included), then each session
is enabled by its first op:
- base and slim9 enable as the first spike did: swap by the deadline, mint by a mint, manage-any by a collect.
- pool3 and pool3v2 enable each pool by its deadline no-op.

USE ops are measured afterwards. `minVGL` is the smallest `verificationGasLimit` with which EntryPoint accepts the op
(eth_call bisection, 10k steps).

| | base | slim9 | pool3 | pool3v2 |
|---|---|---|---|---|
| Enabling ops, total tx gas (paid by the Safe) | 35.82M | 30.93M | **13.15M** | **7.13M** |
| Largest minVGL of an enabling op | 6.08M | 4.72M | 4.60M | **2.43M** (fits today's 3M `V4_GAS_CAPS`) |
| Enabling op signature (FastLZ / raw ABI) | 1.5-2.3 KB / 14.6-38.6 KB | 1.5-2.0 / 11-25 KB | 1.9 / 25 KB | 1.2 / 8.8 KB |
| Swap, USE, tx gas | 630-717k | 602-689k | 568-593k | 518-543k |
| Mint through V2, USE | 1.01-1.06M | 1.01-1.05M | 0.97-1.02M | 0.89-0.95M |
| Collect, USE | 341k | 323k | 323k | 320-323k |

ENABLE mode on pool3 still costs the Safe more (13.15M) than the owner path costs the relayer (10.49M). An enabling op
re-hashes the whole session (EIP-712 over every initData), decompresses it and runs the Safe's 1271 check. That adds
about 0.8M of SmartSession self gas per session on top of the owner path. On Base the owner path is cheaper and
simpler, and it is also one prompt.

## Q2: gas cap for enabling (relevant only if ENABLE mode is built, recommendation 3)

EntryPoint v0.7 charges `actualGas x price` and penalizes **only unused callGasLimit + postOp** (10%,
`EntryPoint.sol` v0.7.0 L720-726). An unused `verificationGasLimit` is not charged. So MamoruGasPolicy's VGL cap bounds
the **prefund** and the worst case (validation that really burns the gas), not routine cost. What a leaked session key
can make the Safe pay per op is `maxFeePerGas x (VGL + CGL + PVG)` caps (`maxCostPerOp`).

| Option | What changes | Worst case per op from a leaked key | Notes |
|---|---|---|---|
| (a) Raise the signed cap: 5.5M for pool3, 7.5M for base | Data only (`V4_GAS_CAPS`) | 7.7e14 wei (pool3, at the 0.1 gwei cap) / 9.7e14 (base), against 5.2e14 today | Only reached by a batch whose validation really burns it (many actions in one op). Usage limits still bound the op count. |
| (a') pool3v2 | No change: the 2.43M enabling op fits the 3M cap | 5.2e14 (unchanged) | Costs the UniActionPolicy layer (see Security). |
| (b) MamoruGasPolicy v2: higher VGL only when `op.signature[0] == 0x01` | New contract, deploy and attest, small audit | USE ops stay at 5.2e14 | "Once per permissionId" is already guaranteed by SmartSession: an ENABLE op needs an owner-signed EnableSession whose per-permissionId nonce is unused, and it is bumped on success. So the mode byte is enough. The policy sees the full `PackedUserOperation`, including the signature. |
| (c) Paymaster pays the enable ops | `permitERC4337Paymaster = true` in the signed session, plus a deployed verifying paymaster (eth-infinitism `VerifyingPaymaster` is a sample, not audited for production) with a deposit | 0 for the Safe on sponsored ops. The paymaster only signs ops it chooses. | New operational surface (deposit, signer key). The flag also lets a leaked key attach its own paymaster; it pays itself, so this is harmless unless a token paymaster holds an allowance. |

Safest for ENABLE mode is (b), or (a') if UniActionPolicy is dropped. With the owner path of recommendation 1, none of
this is needed.

## Q3: one ceremony for Base + Monad

Why a passkey signature is chain-bound today:
- SmartSession's multichain digest has no chainId in its domain (`{name "SmartSession", version "1"}`). The ChainId sits
  inside each `ChainSession`. So the digest itself is chain-agnostic, as shown in the first spike.
- Safe7579's `isValidSignature` with no validator prefix calls `safe.checkSignatures(SafeMessage)` under the Safe
  domain, which includes chainId. That binds every passkey signature to one chain.
- Neither Safe 1.4.1 nor 1.5.0 has a chain-agnostic message option. Safe 1.5.0 still uses
  `EIP712Domain(uint256 chainId,address verifyingContract)`.
- ERC-7739 (Draft) binds chainId too.

Only route found with audited, deployed modules: **Rhinestone `WebAuthnValidator`.**
- Deployment: `0x0000000000578c4cB0e472a5462da43C495C3F33`, version 1.0.0. Code exists on Base and on Monad 143 with
  the same code hash.
- Source: rhinestonewtf/core-modules `src/WebAuthnValidator`. Its `isValidSignatureWithSender` and `validateUserOp`
  verify WebAuthn over `abi.encode(hash)`: raw hash, no chain and no account domain.
- Safe7579 routes to it when `sig[0:20]` is the validator's address (`Safe7579.sol` L333-376).
- What the owner signs: one WebAuthn assertion over `multichainDigest([...Base sessions, ...Monad sessions])`. The
  `permissionEnableSig` is `validator ‖ abi.encode(credIds, usePrecompile, WebAuthnAuth[])` on both chains.
- What must be installed: `Safe7579.installModule(1, WebAuthnValidator, abi.encode(threshold, [pubkey x,y]))` on each
  chain. This is one owner tx per chain, once, and it can ride in the next activation or move tx.
- Audit: ChainLight "WebAuthnValidator Security Audit v1.0" (added 2025-07-30) and ChainLight Q4 2025 (added
  2026-01-20). The deployed bytecode equals the 2025-07-17 artifact (commit 6d01e39). A later change, "remove account
  dependency from credId" (e4d37d6, 2025-12-19), is **not deployed**. Which commit each report covers is unverified
  (the PDFs were not read).

Risks if adopted:
- **A second authority path.** The validator also validates arbitrary userOps for the Safe. Removing the passkey as a
  Safe owner would not remove it: owner rotation and Stop must also uninstall it.
- **Domain-less ERC-1271.** Any `isValidSignature` consumer whose hash does not itself bind chain and account can be
  replayed across chains, and across the user's own Safes that share the credential. Smart Sessions' digest binds
  both, and so do Permit2 and EIP-712 dapps. A raw `personal_sign`-style hash would not be bound.
- **Not usable for Safe owner txs.** Moves and revokes stay one prompt per chain.

Biconomy's K1MeeValidator (merkle root of userOps, signed once) is ECDSA only, with no passkey path. ZeroDev's
multichain validator: no source, addresses or audit found.

## Q4: contract moves

- **Owner path (recommendation 1): solved.** self-attest the new contract (0.43M), plus removeSession of the old set,
  plus enableSessions of the new set, all in ONE Safe tx. Measured 11.75M + 0.43M = 12.2M from a 9-session account.
- **ENABLE mode cannot fold a move into the enable signature.** `SignMessageLib` approval needs a Safe tx (chain-bound
  and nonce-bound). With an empty signature, Safe7579's 1271 reads `signedMessages`, but storing it is itself an owner
  tx. Note the deployed Safe7579 (`0x7579EE83…0002`, v1.0.2) hashes the message as
  `abi.encode(keccak256(abi.encode(hash)))`, unlike newer builds.
- Avoiding moves through "upgradable configs": V2 already versions configs by generation inside one contract, and a
  renewal there retires the old set with no revoke. Making the policy itself upgradable would put an upgrade key above
  every account's guarantees. Not recommended. With one-tx moves, a new contract version costs one prompt.

## Q5: other levers

- **ERC-7715** (Draft): now `wallet_requestExecutionPermissions`. It requires ERC-7710 delegation managers and is not
  the shape of an operator-held SmartSession, so it does not apply. Its "permission + rules" layout is a fair model for
  the app's summary copy.
- **ERC-5792** (Final): one chain per `wallet_sendCalls`. Our app signs Safe txs itself, so it brings nothing.
- **EIP-7702**: authority code must be empty or delegated, so it is not applicable to a Safe.
- **Session key rotation without a prompt.** The key is in `sessionValidatorInitData`, which is in the permissionId and
  the signed digest. OwnableValidator could carry a standby key (threshold 1 of 2). That doubles what can leak, so it is
  only worth it with the standby kept offline. Not recommended now.
- **Longer validity.** V2's per-window and total budgets are the economic bound, and usage limits bound the op count.
  Longer validity cuts prompts per month, not per approval. It is a product decision, kept out of this ticket.
- **Smart Sessions after v1.0.0.** main (f5aaf86) removed the registry and adds new policies, but has no audited
  deployment found. Not worth migrating for gas: the registry is 1.7% of the cost.

## Security: base (today) vs pool3 vs pool3v2

- **Blast radius of a leaked key: unchanged.** All 9 sessions of an account already use the same session key, so a
  leak exposes the whole set in every variant.
- **Revocation granularity.** It becomes per pool instead of per pool x grant type. The ticket's opt-in "approve pool
  by pool" maps 1:1 onto pool sessions. Stop and renew revoke everything in every variant.
- **Usage limits.** One per pool (the sum of the three). A key can spend the pool's uses on any action type. V2's
  budgets, not usage counts, bound value.

What pool3 drops from the UniActionPolicy layer, and what still bounds it:

| Dropped in pool3 | Still enforced by |
|---|---|
| Swap direction per grant (enter-swap only stable→volatile, manage-any only the reverse) | V2 `_checkSwap`: pair, fee, recipient, TWAP band, spot, minOut, and budget charged in both directions. The account already allowed both directions through two sessions. |
| Approve spender per grant (router vs policy) | V2: spender ∈ {SwapRouter02, V2}. Both pull only from `msg.sender`, so an allowance is usable by the Safe alone. Today's manage-any volatile approve already relies on this. |
| Cumulative token totals (`stableSwapTotal`, `mint*Total`, `volatileConvertTotal`) | V2 `total` per pool and generation, and `perWindow`, in budget units. Per-call caps are kept as the largest of the merged grants' caps. |
| Mint minimums > 0 (enter-mint only) | V2 `_checkProvide` (spot inside the band, minimums against spot amounts). Today's manage-any mint already lacks the rule. |
| Swap amountIn cap | Kept but loose: max(stable cap, volatile cap) across units. V2's budget is the real bound. |

pool3v2 additionally drops the approve-amount caps and per-call amount caps, which V2 covers economically through its
budget. It keeps only V2. That turns MamoruActionPolicyV2 (audited by LeftClaw, T6) into the single action layer: a V2
bug would no longer be backstopped. That is why recommendation 2 needs its own review.

## Numbers (this fork, block 51,811,000)

| Flow | Prompts | Gas | Paid by |
|---|---|---|---|
| Today: v5 activation / renewal (first spike) | 2 / 3 | 26.12M / 26.20M | relayer |
| First spike's plan: ENABLE mode, base set | 1 (+1 per extra chain) | 35.8M of enabling ops, plus a cap change | Safe |
| **pool3, owner path: full set / renewal / move from 9 sessions** | **1** | **10.49M / 11.33M / 11.75M (+0.43M attest)** | relayer |
| pool3v2, owner path: full set | 1 | 6.21M | relayer |
| pool3, ENABLE mode | 1 (+1 per extra chain without WebAuthnValidator) | 13.15M; minVGL 4.6M | Safe |
| pool3v2, ENABLE mode | 1 | 7.13M; minVGL 2.43M (today's cap) | Safe |

Headroom: about 3.6M per pool with UniActionPolicy (2.16M without). A fourth pool would push the move case past 14.5M,
so a 4-pool policy needs pool3v2, recommendation 4, or a second tx.

## What changes vs the first spike's plan

**Dropped:**
- ENABLE mode for Base: no `V5_ENABLE_GAS_CAPS`.
- No engine `pending | enabled` state, eager deadline enables, simulated VGL, or two-ops-per-handleOps packing.
- No precheck acceptance of mode 0x01.
- No `revokeEnableSignature` in walkaway.
- No `enable.ts` promotion. Keep t9 and the fixtures for recommendation 3.

**Built instead:**
- **Policy:** a v6 grant shape, `grantsV6(pool)`, with one grant per pool. It is the union of the three v5 grants by
  (target, selector), merged as in `t10` `mergePool`/`mergeRules`, with UniActionPolicy omitted on
  decrease/collect/burn/deadline. Usage limit is the sum. It ships as a new PolicyVersion hash with the engine mapping
  ops to the pool session.
- **Operator:** `planRenew` / `planExtend` / move build ONE owner tx (attest if a new contract, revoke the old set,
  enable the new set) and drop `fitV4`'s split. The `OwnerTxToSign` flow is unchanged.
- **Legacy accounts:** straight to v6 in that one tx (ticket direction 2). Each extra legacy session to revoke costs
  about 0.28M. Check accounts with many per-position grants against 14.5M.
- **Monad:** its own owner tx and prompt in the same dialog.
- **Tests:** promote t10 section C to a release scenario. `--high-stakes` review, since it changes session authority.

## Not verified

- Monad was not forked: gas there is charged on the gas limit, and its registry lacks TimeFrame/UsageLimit (first
  spike).
- Base L1 data fee of the 60 KB (pool3) vs 98 KB (base) of calldata was not priced. It is mostly zero words that
  compress well.
- The ChainLight WebAuthnValidator reports: scope and findings were not read.
- WebAuthnValidator was not installed or tested on the fork.
- Option (b) of Q2 is not implemented.
- A V2 multi-pool design (recommendation 4) is an estimate only.

## Sources

- erc7579/smartsessions v1.0.0 (dc20f0b): `contracts/core/SmartSessionBase.sol` `_enableSessions`,
  `contracts/lib/ConfigLib.sol` `enable`, `contracts/external/policies/UniActionPolicy.sol` `fill`. main f5aaf86
  (registry removed in 32ec01a). Audits are in `audits/` (Cantina 2024-08, ChainLight 2025-08). The deployed
  `0x00000000002B0eCfbD0496EE71e01257dA0E37DE` is byte-identical to the Dec 2024 build.
- eth-infinitism/account-abstraction v0.7.0 `contracts/core/EntryPoint.sol` L720-726 (unused-gas penalty on
  execution gas only).
- rhinestonewtf/core-modules (2eda90a): `src/WebAuthnValidator/WebAuthnValidator.sol`; audits in `audits/` (Ackee 2024,
  ChainLight 2025-07 and Q4 2025).
- rhinestonewtf/safe7579: `src/Safe7579.sol` L333-376 (1271 routing, SafeMessage fallback), L343-353 (empty signature
  reads `signedMessages`), `src/core/AccessControl.sol` (installModule by self).
- safe-global/safe-smart-account v1.5.0 (domain with chainId), `contracts/libraries/SignMessageLib.sol`.
- safe-global/safe-modules passkey `docs/v0.2.1/audit.md` (SafeWebAuthnSharedSigner: Certora, Nethermind).
- bcnmy/mee-contracts v1.0.0 `contracts/validators/K1MeeValidator.sol` (ECDSA only); https://docs.biconomy.io/contracts-and-audits.
- EIPs: 7715 (Draft), 5792 (Final), 7702 (Final), 7739 (Draft) on eips.ethereum.org.
- Deployed code checked with `cast code` against mainnet.base.org and rpc.monad.xyz (read only).
