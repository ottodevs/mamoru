# SmartSession ENABLE mode: one passkey prompt per renewal (otto/mamoru#225, 2026-10-27)

Branch `spike/225-enable-mode`. Local anvil fork of Base only (block 51,811,000, chain id 31337), nothing broadcast
elsewhere, no live operator, D1 or grant touched. Script: `packages/scenarios/action-policy/t9-enable-mode-fork.ts`
(run line at its top; needs the pinned anvil 1.7.1 from `~/.foundry/bin` first on PATH, the nix `foundry` is
`1.7.1-dev` and the harness refuses it). Raw output: `raw/t9-enable-mode-2026-10-27.json`. Full run: exit 0, every
check passes.

## Verdict

**GO for Base, with one contract-side change. NO-GO for "Base and Monad in the same prompt" on the current owner path.**

- Base: the owner signs ONE digest over the whole v5 set (9 sessions); each session is enabled inside a
  session-key userOp sent by our relayer. Measured end to end on the real Safe7579 + SmartSession v1.0.0 +
  MamoruActionPolicyV2 + MamoruGasPolicy stack, with the passkey owner (SafeWebAuthnSharedSigner). A renewal on the
  same contract needs no owner transaction at all: the generation check of V2 retires the previous set by itself.
- Blocker 1 (must change): today's `V4_GAS_CAPS.maxVerificationGasLimit` = 3M is signed into every session's
  MamoruGasPolicy. Every enabling op needs 2.8M to 6.3M of verification gas, so with 3M no session can ever be enabled
  (tested: AA23). Sessions must be signed with a higher cap (measured max 6.32M; recommend 7.5M) or a gas policy that
  allows the higher limit only for an ENABLE-mode op.
- Blocker 2 (Monad): through `Safe7579.isValidSignature` with no validator prefix, the owners sign a SafeMessage under
  the Safe's EIP-712 domain, which includes chainId. A passkey assertion valid on Base is refused on any other chain
  (tested). The SmartSession digest itself is chain-agnostic (a list can name Base and Monad sessions, tested on the
  Base side), but the passkey signature is not. One prompt for both chains needs a chain-agnostic ERC-7579 validator
  (see "Unverified").

## Numbers

Today (same fork, same 9 sessions, operator's own `fitV4` split at `V4_TX_GAS_TARGET`, passkey-signed Safe txs):

| Flow | Owner txs = passkey prompts | Gas |
|---|---|---|
| v5 activation (attest V2 + gas policy, enable 9) | 2 | 13,287,875 + 12,833,602 = 26.12M |
| v5 renewal (revoke 9, enable 9 at generation 2) | 3 | 11,405,187 + 10,334,096 + 4,455,846 = 26.20M |

ENABLE mode, per session (generation 1; generation 2 within ±4%). `minVGL` = smallest `verificationGasLimit` with which
`EntryPoint.handleOps` validates the op (eth_call bisection, 10k steps). `tx gas` = the relayer's handleOps receipt.
Signature = userOp.signature bytes, FastLZ-compressed / raw ABI.

| Session | Enabling op | minVGL enable | tx gas enable | minVGL use | tx gas use (2nd op) | Enable overhead (tx) | Sig bytes |
|---|---|---|---|---|---|---|---|
| enter-swap (stables / btc / risk) | swap deadline alone | 3.16M / 3.13M / 2.94M | 3.09M / 3.03M / 2.85M | 0.41-0.49M | 0.63-0.72M | ~2.4M | ~1,650 / 15,233 |
| enter-mint (x3) | mint through V2 | 2.94M / 3.02M / 3.02M | 3.50M / 3.48M / 3.49M | 0.45M | 1.01-1.04M | ~2.5M | ~1,670 / 15,233 |
| manage-any (x3) | collect | 6.10M / 6.09M / 6.10M | 5.84M / 5.83M / 5.84M | 0.19M | 0.34M | ~5.5M | ~2,420 / 39,233 |
| manage-any btc, gen 2 (Init.admit of the gen-1 position) | collect | 6.32M | 6.03M | 0.19M | 0.34M | ~5.7M | 2,422 / 39,457 |

| Measure | Value |
|---|---|
| Owner signatures for the full set (Base) | **1** (passkey; also valid with the backup EOA) |
| 9 enabling ops, total relayer gas (gen 1 / gen 2) | 36.95M / 36.63M (includes the ops' own execution; enabling part ~31M) |
| Largest single enabling op | 6.03M tx gas (manage-any): fits 2^24 = 16.78M. A handleOps tx must carry the ops' gas LIMITS (~6.9M VGL + 2M call each for manage-any), so one manage-any enabling op per tx, two swap/mint ones |
| Today's owner cap problem | gone: no transaction carries more than one session's enable |
| EntryPoint prefund per enabling op at 7.5M VGL cap | 0.1 gwei x (7.5M + 2M + 0.2M) = 9.7e14 wei (today's cap: 5.2e14) |
| `isValidSignature` cost | paid inside every enabling op (each re-verifies the owner's WebAuthn signature) |
| Self-attest V2 + gas policy (once per contract version) | 432,266 gas, owner tx |
| `revokeEnableSignature(pid)` | 113,585 gas, owner tx |
| `removeSession` x 9 (whole previous generation) | 2,529,780 gas, one owner tx (optional, see below) |
| TS port of `HashLib.sessionDigest` vs `SmartSession.getSessionDigest` | 10/10 equal |

Who pays: today the relayer pays the owner txs; in ENABLE mode the Safe pays each enabling op through the EntryPoint,
like any engine op (~37M gas per full set; at Base's ~0.005 gwei basefee about 1.9e14 wei).

## What the contract does (read from erc7579/smartsessions v1.0.0, the deployed one: it still has the ERC-7484 registry)

- `userOp.signature = 0x01 | flzCompress(abi.encode(EnableSession, bytes sessionKeySig))`; no permissionId in the
  header (it is derived from `sessionToEnable`). `0x02` = UNSAFE_ENABLE: same, without the registry check, and the
  digest then commits to `ignoreSecurityAttestations = true`.
- `EnableSession { uint8 chainDigestIndex; ChainDigest[] hashesAndChainIds; Session sessionToEnable; bytes permissionEnableSig }`,
  `ChainDigest { uint64 chainId; bytes32 sessionDigest }`.
- `sessionDigest = keccak(SESSION_TYPEHASH, account, hashPermissions(session, ignoreAttestations), validator,
  keccak(validatorInitData), salt, smartSession, nonce)` with `nonce = $signerNonce[permissionId][account]`, which
  `_enablePolicies` post-increments. Per permissionId, per account: one signature over N digests enables N sessions.
- Checked: `hashesAndChainIds[i].chainId == block.chainid`, `hashesAndChainIds[i].sessionDigest == computed`, then
  `account.isValidSignature(multichainDigest(list), permissionEnableSig) == 0x1626ba7e`. The multichain digest's
  EIP-712 domain is `{name "SmartSession", version "1"}`, no chainId.
- Safe7579 1271: `sig[0:20]` = validator; `address(0)` or not installed falls back to `safe.checkSignatures(SafeMessage
  under the Safe domain)`; an empty sig checks `safe.signedMessages`. With the passkey the Safe signature is a v=0
  contract signature of SafeWebAuthnSharedSigner whose WebAuthn challenge is the SafeMessage hash.
- After enabling, the op is checked like a USE op with the NEW session's policies, including MamoruGasPolicy (hence
  blocker 1) and UsageLimit (the enabling op is use #1) and TimeFrame. Validation of an enable runs the policies'
  `initializeWithMultiplexer` (V2 reads the pool for `_depthIn`) in the validation phase: fine for our self-bundled
  relayer, not for a public ERC-7562 bundler.

## Replay and nonce semantics (all tested)

| Case | Result |
|---|---|
| Same signature, sessions 2..N after session 1 | enabled (9/9 from one signature) |
| Same enable data again for an enabled session | refused, `HashMismatch` (its nonce is 1 now) |
| A session not in the signed list (same list) | refused, `HashMismatch` |
| A digest appended to the list (old signature) | refused (Safe `checkSignatures` reverts) |
| Owner `removeSession` of an enabled session, then replay | refused, `HashMismatch` |
| **Owner `removeSession` of a signed but never enabled session, then enable** | **INCLUDED: removeSession does not void a pending signature** |
| Owner `revokeEnableSignature(pid)` of that pending session, then enable | refused, `HashMismatch` |
| A never-enabled generation-1 session after generation 2's first enable | refused, `StaleGeneration` from V2's Init |
| Enabling op with `verificationGasLimit` over the session's own cap | refused, `PolicyViolation(MamoruGasPolicy)` |
| ENABLE before V2 + gas policy are self-attested | refused, `InsufficientAttestations`; UNSAFE_ENABLE is included |

## Renewal and the previous generation

- On the same contract (V2 to V2) no owner transaction is needed besides the one signature: the first enabling op of
  generation 2 (here manage-any btc, a collect) bumps `generationOf`, and every generation-1 session, in every pool,
  is refused from then on (`checkAction` returns VALIDATION_FAILED when the binding's generation is not current), even
  while SmartSession still lists it as enabled. A signed-but-never-enabled generation-1 session cannot be enabled later
  (`StaleGeneration`). The old sessions then lapse by TimeFramePolicy. `removeSession` of all 9 is 2.53M gas in one
  owner tx: defence in depth, not required; it can ride in the next owner action (stop, withdraw) instead of costing a
  prompt.
- Lazy order breaks today's "Init.admit only on the first grant of each pool": whichever session of a pool is enabled
  first must admit the held positions. Tested with admit on every session of the pool (admit is idempotent and not in
  V2's `_initHash`); manage-any enabled first collects the generation-1 position.
- Across contracts (V1 to V2, or any future V3) the old sessions are NOT retired by the new contract's generation.
  That move still needs an owner tx (attest the new contract + removeSession of the old set).
- `swapBounds` reverts until the session's Init exists, so the engine cannot price the first swap of a pool before its
  session is enabled. The spike enables swap sessions eagerly with the swap-deadline call alone (a no-op every v5
  grant accepts); mint and collect sessions were enabled lazily by real ops.

## Unverified

- Monad: not forked. The Base side accepts a list carrying Monad (143) entries; the passkey signature cannot cover both
  chains via the Safe owner path (proved above). Monad also lacks TimeFramePolicy/UsageLimitPolicy (registry) and
  charges the gas LIMIT (`gasModel: 'gas_limit'`), so 6-8M verification limits cost more there.
- One prompt for Base + Monad via Rhinestone's `WebAuthnValidator` (core-modules): its `isValidSignatureWithSender`
  verifies WebAuthn over the raw hash (no chain domain), so one assertion over the multichain digest would be valid on
  every chain where it is installed with the same credential (Safe7579 routes to it with `sig[0:20]` = validator).
  Not tested: deployment addresses on Base/Monad, install cost, audit status, and the general risk of a
  domain-less 1271 (any consumer that does not bind chainId becomes replayable across chains).
- Approving the digest with `SignMessageLib` inside an owner Safe tx (Safe7579's empty-signature path reads
  `safe.signedMessages`), which would let a contract move do attest + revoke-old + approve-digest in one prompt.
- The real browser authenticator (the fork uses the software passkey with the same SafeWebAuthnSharedSigner encoding
  as `signSafeTxWithPasskey`); the RIP-7212 precompile and the P256Verifier fallback both verify on the fork.
- Base L1 data fee of the enabling ops (1.6-2.4 KB compressed signature each, ~16 KB per set) against today's owner
  txs; not priced.
- A handleOps carrying two enabling ops (limits say two swap/mint ones fit); each op was sent alone.

## Implementation plan (one prompt per renewal on Base; Monad stays a prompt of its own)

1. Contracts / caps: sign v5 sessions with `maxVerificationGasLimit` 7.5M (new `V5_ENABLE_GAS_CAPS` in
   `packages/policy/src/v4-grants.ts`, used by `withActionPolicy` for v5). It takes effect from the first ENABLE-mode
   set itself (the cap is in the data being enabled). Cleaner alternative, needs a deploy: MamoruGasPolicy v2 that
   allows the higher limit only when `op.signature[0] == 0x01`, keeping USE ops at 3M (bounds a leaked key at today's
   5.2e14 wei per op).
2. `packages/account/sessions/enable.ts` (promote `packages/scenarios/fixtures/enable-session.ts` + `flz.ts`):
   `sessionDigest`, `multichainDigest`, `safeMessageHash`, `ownerEnableSig`, `enableModeSignature`; unit tests pinned to
   `getSessionDigest` vectors from t9. `v4PoliciesFor(..., { admitEverywhere: true })` for enable-mode sets.
3. Operator `apps/mamoru-operator/src/operator.ts`:
   - `planRenew` (v4/v5, same contract) and `planExtend`: no `fitV4` split and no calls; build the full set, read
     `getNonce` per permissionId, compute the list and the multichain digest; `hold()` stores the sessions + list and
     returns a new `OwnerTxToSign` variant whose challenge is `safeMessageHash(safe, chainId, digest)`.
   - Submit: wrap the assertion with `safeContractSignature(SharedSigner, …)` + 20 zero bytes, check
     `isValidSignature` by eth_call, store the pending set; the renewal counts as applied when the first enabling op is
     included (`generationOf` moved), replacing the owner-tx receipt in `settleRenewals`.
   - Previous generation: no revoke in the renewal; remember it in `superseded` and revoke it in the next owner
     transaction the owner makes anyway. Contract moves and first activations keep one owner tx (attest + revoke old),
     then the enable digest (2 prompts; 1 if the SignMessageLib path above verifies).
   - Stop / walkaway (`packages/account/owner/index.ts` `walkawayCalls`): add `revokeEnableSignature` for every
     signed-but-not-enabled permissionId: `removeSession` does not void it.
4. Engine `packages/scenarios/driver/engine.ts`: per session, `pending | enabled`; the first op of a pending session
   carries `enableModeSignature`; `verificationGasLimit` from simulation for enabling ops (2.8-6.4M) instead of
   `LAB_GAS_LIMITS` 3M; `preVerificationGas` from the real signature size; right after the owner signs, enable swap
   sessions eagerly with the deadline call (bounds need the Init), the others lazily or eagerly the same way; relayer
   packs one manage-any or two swap/mint enabling ops per handleOps (limits, not usage, must fit 2^24).
5. Precheck `packages/account/precheck/index.ts:234`: accept mode `0x01`, decode the enable data and check the op
   against `sessionToEnable` (and that it is the operator's pending set) instead of refusing every non-USE mode.
6. App: `packages/domain/src/app-api.ts` `OwnerTxToSign` gets `challenge` (+ kind `enable-digest`);
   `apps/mamoru-app/src/web/lib/passkey-sign.ts` signs `challenge` when present; `owner-flow.ts` and the renew summary
   say "one approval, applied as Mamoru next acts". No RP ID change.
7. Monad: separate prompt per chain until a chain-agnostic validator is decided; if it is, install it in the
   activation owner tx on both chains and sign the multichain digest raw (one prompt for both).
8. Tests: promote t9 into the release scenarios; `bun run release:check`; independent review with `--high-stakes`
   (it touches signing and session authority).
