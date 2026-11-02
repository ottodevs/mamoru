# 010: One authorization: the owner signs to create and to withdraw, nothing else

Ticket: otto/mamoru#291 (milestone "One authorization": #292 contracts, #293 operator, #294/#295 app, #296 /ops).
Decision: Brais, 1 Nov (chat-mamoru thread "[firma única]"), OK from Ot on 2 Nov, who had asked the same in #281.
Noema `1-projects/mamoru/decisions/2026-11-02-firmar-solo-crear-y-retirar.md`.

**Amendment A1 (Ot, 2 Nov 18:30)**: noema `1-projects/mamoru/decisions/2026-11-02-v4-sin-guardian-registro-sin-admin.md`.
V4 is aligned with spec 009 (`specs/009-hermetic-infra`) before it goes on chain: **no guardian** and **no registry
admin**. What A1 changes is listed in "Amendment A1" below; the sections that follow are already written as amended.
Status: spec r2 + A1. Contracts #200/#209 and operator #202 are merged behind `one_auth_v4`; nothing is deployed
(`packages/registry/*.json` lists `MamoruRegistry`, `MamoruActionPolicyV4`, `MamoruGasPolicyV2` and
`MamoruMigrationCheck` as undeployed). The T7 deploy is on hold until A1 lands (otto/mamoru#292 comment 23892, #307,
#83).

## Problem

Today a Mamoru account asks its owner for a passkey signature whenever the engine's scope changes:

- **A new pool or vault.** `MamoruActionPolicyV3.Init.pool` binds each config to one pool. The vault allowlist is
  fixed in `MamoruV3Routes`' constructor.
- **A new chain.** The remote Safe and the bridge-out grant (`mintRecipient EQUAL REMOTE_ACCOUNT`, `grants.ts:375`)
  are fixed when the owner signs (design C, #251).
- **Expiry and lifetime caps.** These stop the engine without the owner deciding anything:
  - `TimeFramePolicy`: 365 days.
  - `UsageLimitPolicy`: 36,000 userOps per pool session in v6.
  - V3 `total`: 10 x C_p per generation.
  - The bridge `cumulative` cap.
- **Upgrades.** v2 → v6 each needed a signed move, sometimes over several transactions (#259).

Brais's rule: the user trusts Mamoru once, when creating the account, and signs again only to take money out.

## Decision

The owner signs the **rules** once; Mamoru picks **within** them. The rules are code, not data that someone keeps
editing:

- Which pools are eligible is decided by **rules checkable on chain** (official factory, pinned tokens, depth, TWAP),
  not by a list someone maintains. Vaults and chains are **fixed tables in V4's code**.
- Everything that could move money to someone else (the Safe stack, CCTP, the shape of the remote account) is
  **pinned in V4's code**.
- Each account carries **one long-lived session** whose only action policy is `MamoruActionPolicyV4` and whose userOp
  policy is `MamoruGasPolicyV2`. No expiry, no lifetime total.
- **No one holds a key over V4 after deployment**: no guardian, no registry admin, no owner, no upgrade. Adding a
  token, a vault or a chain means a new V4 version, which the owner may adopt on the "What's new" screen; the old one
  keeps working.

| Owner signature | When |
|---|---|
| Create + authorize | sign-up (one screen, #294; two OS prompts until #116) |
| Withdraw / stop | every withdrawal (owner Safe tx, unchanged: `planTransfer`, `planStop`) |
| Migrate | once, for every account on v2–v6 (the "What's new" screen, #295); a second prompt only for an account that already has a design-C remote Safe |
| New V4 version | only for a new token, vault or chain, or a V4 replacement; optional, and the old one keeps working |

### Pinned in V4 (constructor-free constants, identical bytecode on every chain)

V4 and its helpers are deployed with **CREATE2 through the canonical deterministic deployer**, with
**chain-independent init code** and no constructor arguments that differ by chain. The same address therefore implies
the same code on every EVM chain, so a policy on Base can reason about what lives at an address on Monad. Constants:

- **Safe stack:** SafeL2 1.4.1 singleton, SafeProxyFactory 1.4.1, MultiSend 1.4.1, Safe7579 adapter + launchpad,
  `SafeWebAuthnSharedSigner`, and the SmartSession. All of these are canonical CREATE2 deployments already at the
  same address on Base and Monad (`base.json` / `monad.json`), and on Ethereum (read on chain, 2 Nov). V4 also checks
  at enable that each one has code on the local chain, with the expected `EXTCODEHASH`.
- **`address(this)`** (the remote V4): CREATE2, the same on every chain.
- **CCTP:** the canonical `TokenMessengerV2` (`0x28b5a0e9…cf5d`) and `MessageTransmitterV2` (`0x81D40F21…4B64`). Both
  have code on Base, Ethereum and Monad, and `localDomain()` returns 6, 0 and 15 (read on chain, 2 Nov). The burn token
  is not a constant: V4 accepts a token only if the canonical messenger's own `localMinter()` accepts it as burnable
  (non-zero burn limit).
- **Per-chain table, keyed by `block.chainid`** (`MamoruV4Chains`):
  - Uniswap v3 factory, NPM, SwapRouter02, the wrapped native, the stable tokens (native USDC, USDT where CCTP burns
    it) and the assets (WETH, cbBTC, WMON…).
  - The **pool classes** and their risk parameters (see "Eligibility rules").
  - The **vault list**: exact vault addresses, each with its asset and ratio (see "Eligibility rules").
  - The gas parameters of `MamoruGasPolicyV2`.
  - Chains: Base, Monad and Ethereum. A chain outside the table refuses everything (fail closed). Adding Arbitrum,
    Optimism or Unichain is a new V4 version.
- **Hard bounds:** V3's band, window and anchor limits (`MIN/MAX_TWAP_WINDOW`, `MIN_SHORT_WINDOW`,
  `MIN_WINDOW_RATIO`, `MIN_BAND`, `MAX_BAND = 500` ticks), `ratioBps ≤ 10,000` (vaults ≤ 5,000), `DEPTH_MULTIPLE = 20`,
  and `MAX_CHAINS = 4` per account (the home chain plus at most three remotes). The class parameters in the table are
  checked against these bounds by the deploy script and by a unit test.

### Eligibility rules (replaces `MamoruRegistry`)

There is no registry contract. V4 decides eligibility from on-chain facts at every use. Nobody can add, remove or
re-parameterize an entry.

- **Pools.** A Uniswap v3 pool is eligible for an **entry** (swap in, mint, increase) when all of these hold:
  1. `factory.getPool(t0, t1, fee) == pool`, with the chain's pinned factory;
  2. one token is a pinned stable (the budget token) and the other a pinned stable or a pinned asset;
  3. `fee` is in the pinned fee set of the pair's class;
  4. the pool can serve `observe` over the class's `twapWindow` (enough observation cardinality; a pool that cannot
     makes the TWAP read revert, so it fails closed);
  5. at the priced use, the in-band depth covers `DEPTH_MULTIPLE` × the call's value (I2);
  6. for a stable/stable pool, the anchor check holds (the price is within `anchorBand` of 1:1).

  Risk parameters come from the pair's **class**, a row of the table: stable/stable, and one row per pinned asset
  against the stable (`twapWindow`, `shortWindow`, `bandTicks`, `anchorBand`, `ratioBps`, fee set). They are not set per
  pool by anyone.
- **What the old "remove immediately" protected, now by rule.** A pool that turns thin fails (5) at its next use. A
  depegging stable pool fails (6). A manipulated price fails the two-TWAP band. Exposure to one pair is capped by a
  **per-pair sub-bucket** (keyed by the token pair, across every fee tier and pool of that pair) at the class's
  `ratioBps` of C, so a second pool of the same pair adds no room. A token that fails as an asset (an issuer freeze, a
  broken bridge) is an issuer risk (spec 009 WLK-06): its exposure is capped by the pair's ratio, and a new V4 version
  drops it.
- **Exits are never gated by eligibility.** `decrease`, `collect` and `burn` of an admitted position, and `redeem`
  from a listed vault, stay allowed whatever the pool's or vault's eligibility is now (V3's LeftClaw M-6: the anchor
  never locks an exit). Converting the proceeds back to the budget token is a priced swap and needs an eligible pool of
  that pair; if there is none, the tokens stay in the user's Safe, where the owner can always move them.
- **Vaults.** Only the **exact vault addresses** in the chain's table, each with a pinned stable as `asset()` and a
  ratio ≤ `MAX_VAULT_RATIO_BPS`. A factory check alone is not enough without an admin: anyone can create a MetaMorpho
  vault with a hostile curator that allocates deposits to a losing market. Today's candidates are the vaults spec 004
  measured on Base (T2 fixes the list). Monad and Ethereum list none. A listed vault's curator can still reallocate
  within Morpho's rules: that is the venue risk spec 009 POL-07 caps, here by the vault's ratio of C.
- **Chains.** Every chain in the table is a route. A route is usable for an account only once that account's remote
  on it is **proven ready** (I4). There is no on/off flag.
- **Engine.** The operator enumerates candidate pools off chain (factory events and the pinned token pairs) and
  checks them with V4's views; `/ops` #296 shows which candidates pass which rule.

### Invariants

1. **Funds only ever land in a Safe the owner controls.** Every recipient, receiver, owner field and CCTP
   `mintRecipient` is the account itself, or `remoteOf(account, domain)` (I4).
   - **The account approves only V4** (r3 P1). Every spending action is a V4 function the session calls:
     `swap`, `mint`, `increase`, `deposit`, `redeem`, `bridge`.
   - Each one pulls the exact amount from `msg.sender` (the account), approves the pinned router / NPM /
     messenger / listed vault for exactly that amount, performs the operation with the account as recipient,
     then sets the allowance back to 0 and returns any rest.
   - An allowance left on V4 is inert: V4 only spends the allowance of the account calling it, inside its own
     functions, under every check below.
   - The fallback action refuses any `approve` whose spender is not V4, and any direct call to the router, NPM,
     messenger or a vault, except `decrease`/`collect`/`burn` on admitted positions (they move no tokens out of
     the account).
2. **Price and depth.** V3's two-TWAP band (plus the anchor on stable pools), with the class parameters from the
   table. **At every priced use** (not only at enable, as V3's M-5), the pool's in-range liquidity over the band must
   cover `DEPTH_MULTIPLE` (20) times the call's value. Distorting a TWAP then costs the attacker capital that grows
   with the depth (r3 P1). The bound is still stated conservatively: see the threat model.
3. **Positions.** As V3: only positions minted through V4, or admitted at migration, that the account still owns.
4. **Remote Safe.** `remoteOf(account, domain)` is computed **inside V4** from:
   - **The account's current owners**, read on chain at `registerRemote`: `Safe.getOwners()`, the threshold, and
     `SafeWebAuthnSharedSigner`'s current (x, y) configuration for the account. These are never the original
     initializer, so a rotated or removed key is not carried over (r2 P0).
   - **A salt** of `keccak(account, domain, ownersHash)`.
   - **V4's own canonical initializer.** It is a plain Safe setup (owners, threshold, the shared-signer
     `configure`) plus the 7579 adapter and the SmartSession, installed with the account's **own self-attestation** as
     the only trusted attester (the production enable flow, T1). No third party can revoke it, so deployment depends on
     nothing that can change after a mint: anyone can deploy the address at any time through the permissionless
     factory, and the result is always the user's Safe (r2 P0).
   - **Readiness is proven on chain, by a CCTP message, not by a key** (A1; replaces the guardian's `setReady`):
     - V4 refuses a burn unless `readyOf[account][domain]` equals `remoteOf(account, domain)` for the account's current
       `ownersHash`.
     - On the destination chain, anyone may call `V4.announceReady(remote)`. V4 there reads back, locally: code at
       `remote` with the Safe proxy's `EXTCODEHASH`; owners, threshold and shared-signer (x, y) matching the
       `ownersHash`; the 7579 adapter and the SmartSession installed; and a V4 session bound for `remote`. All of this is
       what the guardian used to read back off chain (`apps/mamoru-guardian/src/watcher.ts`). If every check holds, it
       sends a CCTP message through the pinned `MessageTransmitterV2` to the home domain, at finality (`2000`), with
       body `(homeOf[remote], remote, ownersHash)`.
     - On the home chain, V4's `handleReceiveFinalizedMessage` accepts the message only when `msg.sender` is the pinned
       `MessageTransmitterV2`, the source domain is in the table, and the sender is `address(this)`, the same V4 on the
       other chain. It then writes `readyOf`. Anyone can relay the message (`receiveMessage` is permissionless); the
       user's own session does it as a userOp (spec 009 G5/G6), so the user pays.
     - Any change of `remoteOf` (a key rotation) or of the account's `ownersHash` clears `readyOf`, and a new
       announcement is needed.
     - **Trust added:** none beyond CCTP, which already moves the funds. A forged message (only Circle could forge
       one) makes V4 burn to `remoteOf`, the user's own deterministic address, which anyone can deploy with the
       constant initializer. Circle forging it gains nothing it could not already do as issuer (spec 009 WLK-06).
   - The setup itself is **T1b**, run before any V4 code: the exact canonical initializer, with the
     self-attestation *inside* setup, deployed on a fork after funds were sent to its address.

   **Key rotation** (r3 P0-1): an owner change on the home Safe is already an owner-signed ceremony. Under V4 the
   ceremony also rotates the owners of every registered remote Safe (one more passkey prompt per remote chain;
   rotations are rare), and the app does not report the rotation as done until every remote reads back the new
   owners. Until then V4 refuses burns, because `readyOf` was cleared.

   **Accepted residual risk, stated in the app:** a passkey that is compromised (not merely lost) controls every
   remote Safe until it is rotated there. This is the same for every multichain smart wallet, and is today's
   property of design C. Ops alerts on any owner tx of a remote Safe that Mamoru did not prepare.

   V4 stores `ownersHash` with the remote and refuses every burn while the account's current owners hash differs.
   `registerRemote` may then compute a new remote. The old remote's own V4 sends its funds back only to the home
   account, its fixed `homeOf`. The result is a Safe with the same code as every Mamoru Safe, owned by the user's
   current keys. Its one session is bound by the same V4. `registerRemote(domain, sessionKey)` is only callable
   through the account's own session.
5. **Budget.** Per chain, one value bucket for the account, in USD-stable units, refilled each window, with:
   - **Per pair and per vault:** at most the class's or vault's `ratioBps` of the bucket.
   - **A rolling 30-day cap** of `3 x capUsd` per chain on spend. It bounds loss in any 30 days and never ends the
     authorization.
   - **A rolling 24 h cap** of `capUsd` (the old "breaker"). A spend that would pass it is **refused**; nothing is
     paused, so the next window works again by itself (A1).
   - No lifetime total and no cumulative review threshold (A1): see the threat model for what that costs and how it is
     bounded.
6. **Gas.** `MamoruGasPolicyV2` (userOp policy) keeps the per-op caps on all six gas fields (`callGasLimit`,
   `verificationGasLimit`, `preVerificationGas`, `paymasterVerificationGasLimit`, `paymasterPostOpGasLimit`,
   `maxFeePerGas`) and replaces the guardian-reset `GAS_REVIEW` with a **rate limit that needs no clock at
   validation** (A1, and spec 009 POL-12: ERC-7562 bans `TIMESTAMP` in validation):
   - Each op is charged at validation at its most expensive cost, `c = (sum of the five gas limits) × maxFeePerGas`.
   - **Claimed time.** Every session batch starts with a call `V4.clock(T)`, which the fallback action requires and
     decodes at validation. The gas policy returns `validAfter = T − S` and `validUntil = T + S` in its validation
     data (`S`, a pinned slack of a few minutes, well under `W / 2`), so the EntryPoint admits the op only while the
     real time is within `S` of `T`. The policy thus knows the time to within `S` without reading `TIMESTAMP`. In
     execution, `clock` only asserts `|block.timestamp − T| ≤ S`.
   - **Rate (GCRA).** The policy keeps one value per account, `tat` (theoretical arrival time). It computes
     `newTat = max(tat, T) + c × W / G`, where `G` is the chain's gas allowance per window `W` (table), refuses the op
     if `newTat − T > W`, and otherwise stores `newTat`. Every op of a bundle is validated before any executes, and each
     one advances `tat`, so a bundle of many ops is bounded like a sequence.
   - **Bound:** at most `G` per `W`, plus a burst of `G` (and `S / W` of `G` for the slack), including ops that
     revert, and never more than the Safe's native balance plus its EntryPoint deposit. An idle account comes back with
     at most that burst, and needs no reset.
   - No action-free userOp: V4 refuses an empty batch, a batch without the leading `clock`, and a call it cannot
     classify, through the fallback action.
   - T1c probes on forks that SmartSession intersects the time range a userOp policy returns, as it does for
     TimeFramePolicy, and that a standards-compliant bundler admits these ops.
7. **No guardian.** V4 and `MamoruGasPolicyV2` have no `GUARDIAN`, no `pause`, `unpause`, `review`, `setReady` or
   `cancel`, no pause state, and no address with any power over them after deployment. The deploy script refuses a
   source that contains any of these (spec 009 POL-01).
8. **Nothing to add or remove.** Eligibility is by rule (above). A token, vault or chain outside the table, or a
   different class parameter, is a new V4 version, adopted only by an owner signature.
9. **ERC-7562-compliant validation** (spec 009 POL-12). V4's `checkAction` reads only storage keyed by the account
   and does no external reads: targets, selectors, decoded recipients and the batch shape. The price, depth, budget
   and position checks run in execution, inside V4's own entry points, which are the guard spec 009 POL-12 requires.
   The exit checks that V4 makes in validation today (`_checkExit` reads the pool and the registry entry) move to a
   required `V4.checkExit(tokenId, liquidity, amount0Min, amount1Min)` call placed immediately before each
   `decrease`, with its arguments bound to the `decrease` calldata, as POL-12 binds the guard. `collect` and `burn`
   stay static (recipient = account, admitted position).

### MamoruActionPolicyV4

- **V3 kept:**
  - The Uniswap checks: band, admitted positions, `mint`/`increase` through the policy, swap deadline, LeftClaw
    fixes.
  - `initializeWithMultiplexer` only from `SMART_SESSION`.
  - The setup mode for new accounts.
- **Init (owner-signed, account-wide):** `{ capUsd, admit[], generation }`. Owners come from the account's state
  on chain, never from the Init.
- **No pause check, no PauseGate** (A1). A breach of a limit is a refusal of that call, never a state that someone
  must clear.
- **One session per account and chain:**
  - A single fallback action whose only policy is V4.
  - The userOp policy is `MamoruGasPolicyV2` only.
  - T1 (fork probe) confirmed the deployed SmartSession supports this. No TimeFramePolicy: if one is ever kept, it
    needs `validUntil = 0` with `validAfter ≠ 0` (T1).

### Migration (v2–v6 → V4)

- **Inventory** (r1 finding 4):
  - The operator rebuilds the account's complete set of Mamoru permission ids from SmartSession's own
    `SessionCreated` / enable events for the Safe, cross-checked with `accounts.json`.
  - A mismatch means no migration is offered: an ops alert, fail closed.
- **One Safe transaction:**
  1. `removeSession` for every id.
  2. Enable V4.
  3. A last call to `MamoruMigrationCheck.assertNone(account, ids)`, which reverts if any id is still enabled.
- **Old policy state:** the old policies' state (V2/V3 generations, buckets) can no longer act once their
  sessions are removed. No old policy is ever called again. The V2/V3 guardian's power over the account ends with
  this transaction (spec 009 GRD-03).
- **Design-C remote Safes** (r1 finding 5; today one account, b54dda3a):
  - They cannot be migrated from Base. Their bridge stop (`REMOTE_BRIDGE_STOP_SECONDS`) stays until they are
    migrated.
  - The migration screen asks a second passkey prompt, on Monad, that:
    1. removes the remote V3 sessions;
    2. enables V4;
    3. moves the remote Safe's funds to `remoteOf(account, 15)` if that is a different address. Both Safes
       belong to the user.
  - No new design-C remote Safe is created after V4 ships (`multichain_v6` stays scoped).
- **A user who taps "Not now"** stays on v2–v6, renewals included, and stays flagged as non-compliant with spec 009
  C4 while a guardian-bearing grant is live (spec 009 GRD-04).

### What the operator stops doing (#293)

- **Removed:**
  - The renew/extend/upgrade family: `planRenew`, `planExtend`, `prepareRenew`, `settleRenewals`, `renewTarget`,
    `assertRenewable`, `renewRefusal`, and the `'renew'` owner kind.
  - The `V*_MIGRATES_FROM` chains, `upgradeSplitOf` and `missingGrants`.
  - The usage refresh.
  - This applies to V4 accounts only.
- **Changed:** the engine's pools are the candidates that pass V4's eligibility views, not `registry.activePools()`.
- **Retired (A1):** the guardian watchdog `apps/mamoru-guardian` and every call to `setReady`, `pause`, `unpause` and
  `review`. Its read-back checks move into V4's `announceReady` (I4).

## Ethereum and siblings (#307, before T7)

Ot, 2 Nov (#281): an owner whose funds sit on Ethereum signs once and Mamoru does the rest. Guillermo (#117) holds
0.05537835 ETH at his account's own address on Ethereum (the same SafeProxyFactory CREATE2 address as on Base), and
that Safe is not deployed. V4's bytecode is pinned, so this goes in before T7; afterwards it would be a new V4 and a
new owner signature.

- **Ethereum in the table:** chain 1, CCTP domain 0. Uniswap v3 (factory, NPM, SwapRouter02), USDC, WETH. USDT is
  left out: its CCTP burn limit is 0 there. No vault. The whole pinned Safe stack has the same code hashes on
  Ethereum (read on chain, 2 Nov). Domain 0 is never a "none" sentinel (`chainOf`).
- **Sibling:** an Init with `home == account` on another domain of the table. It bridges only to its own address on
  the home domain, and only once that address is **proven ready by a CCTP message from the home chain's V4** (A1,
  replaces `setReady`): on the home chain, `V4.announceReady(account)` reads the home Safe back locally (code, owners
  hash, shared signer, modules, V4 session) and sends `(account, account, ownersHash)` to the sibling's domain. The
  sibling's V4 accepts it under the same rules as I4. A sibling has no remotes.
- **Wrap:** native value only to the chain's pinned wrapped native, `deposit()` and `withdraw(uint256)`, both to the
  account. This is not charged, because the value stays the account's.
- **The one signature on a Safe set up before V4 (#309):** the production enable flow, as on Base. One owner Safe tx
  (MultiSend: trust the Rhinestone attester and the Safe itself, self-attest V4 and the gas policy, which T7 deploys
  with ModuleRecords, then `enableSessions`), relayed after a permissionless deploy of the Safe with its own
  initializer. SmartSession ENABLE / UNSAFE_ENABLE would also work (the fork test shows it), but production keeps no
  ENABLE signatures (`no-enable-mode.test.ts`, the base of the old-session inventory: handoff 2 Nov, not reopened).
- **Limit:** Safe7579's owner path verifies the signature over a SafeMessage under the Safe's own domain separator,
  which contains the chain id. One passkey assertion therefore authorizes one chain. An account set up before V4
  approves once in the app, with one passkey prompt per chain where it holds funds (Guillermo: Base and Ethereum, 2).
  One prompt for every chain would need a chain-agnostic validator in the account's setup: new accounts only, #116.

## Threat model (A1)

Worst case per chain, with V4's hard bounds and `capUsd = C`. Nobody holds a key over V4, so the rows about a registry
admin and a guardian are gone.

| Who | What they can do | Bound |
|---|---|---|
| Leaked session key | V3's attacks within the band and the bucket, on any eligible pool or listed vault, and bridges to the user's own ready remotes | **Value exposed:** at most C per 24 h and 3C per rolling 30 days per chain, × the chains where the account holds funds, until the owner stops the session. There is no lifetime total (A1), so over a year the conservative figure is 36C per chain. **Value an attacker can extract:** funds only ever reach the user's own Safes (I1), so the extraction channel is trades the key forces at a bad price, which V4 bounds by the band (`MAX_BAND` 500 ticks, about 5.1 %) and the depth check: at most about 5.1 % of the spend plus pool fees, i.e. about 0.15C per 30 days per chain at the hard bounds, and less at the class parameters. Spec 007's measured loss (6.6 % of cap per day per pool) is the expected case at today's parameters. Key-free mitigations: per-account session keys in a KMS or TEE (spec 009 KEY-01/05), ops alerts that ask the owner for one tap to stop, and the 24 h and 30-day multiples sized from the engine's real spend (open question 4). |
| Leaked session key, gas | Repeated no-op or tiny userOps paid by the Safe | `MamoruGasPolicyV2`'s rate: at most G per W plus a burst of about G; never more than the Safe's native balance and EntryPoint deposit. G is sized at about twice the account's normal use (open question 5). The empty batch and a batch without `clock` are refused. |
| Hostile pool of pinned tokens | Someone creates a thin pool of pinned tokens on the official factory | The depth check at every priced use, the two-TWAP band, the anchor for stable pairs, and the per-pair sub-bucket. The pool can only be used for the pair's ratio of C, at band slippage. |
| Listed vault's curator | Reallocates the vault within Morpho's rules | The vault's ratio of C (`held + assets ≤ C × ratio`), as spec 009 POL-07 caps an upgradeable venue. |
| Compromised operator / Worker | Pick bad pools among the eligible ones, refuse service | Within I1–I6. Withdrawal stays owner-only. Refusal stops Mamoru's offer, not the user (spec 009 WLK-04). |
| Circle (CCTP issuer) | Withhold or forge attestations, freeze USDC | Withholding stops bridges and readiness, never funds at rest. A forged readiness makes V4 burn to the user's own deterministic `remoteOf`, which anyone can deploy (I4). Issuer risk, documented (spec 009 WLK-06). |
| A new chain | Needs a new V4 version (A1) | The table is a constant. A chain without the canonical deployer, or with different CREATE2 semantics, cannot host V4 at the pinned address, so no readiness message can come from it. |
| Wrong table at deploy (a bad class parameter, a wrong vault address) | Nobody can fix it in place | Every value is checked against V4's hard bounds by the deploy script and a unit test; a fork test runs the exact deploy; a mistake stays until a new version, which owners adopt by choice. |
| The Mamoru team after deploy | Nothing on V4 | No owner, no admin, no guardian, no upgrade. |

What the owner gives up compared to V3: per-pool consent and a per-approval total. What they get: no renewals, no
stop at day 365 or at a usage limit, no tap for each new pool, and no one who can pause or steer their account. The
24 h and 30-day caps are hard bounds that do not end the authorization.

## Amendment A1 (2 Nov): what changed and why

Ot's premises for Mamoru infra (spec 009 C2–C6): nobody can pause, freeze or steer a user, and Mamoru infra has no
admin after it is deployed. r2 of this spec kept two pieces that break them, and A1 removes both before deployment.

| r2 | A1 | Why |
|---|---|---|
| Guardian key: pause, unpause, `review`, `setReady`, registry `cancel` | Removed (I7) | A key that can pause users is the custodial power C4 forbids, and the key is an attack target |
| Breaker pauses the account until the guardian unpauses | The 24 h cap refuses the call; nothing to clear (I5) | Same bound, no state a person must reset |
| 10C cumulative review threshold | Removed; the bound is the 24 h and 30-day caps plus band-limited extraction (threat model) | A review needs a reviewer with power |
| `GAS_REVIEW` reset by the guardian | A clock-free GCRA rate in `MamoruGasPolicyV2` (I6) | Same purpose, no reviewer, and ERC-7562 compliant |
| `setReady` written by the guardian after an off-chain read-back | `announceReady` on the destination chain, delivered by a CCTP message from the same V4 (I4) | The same read-back, done by code; trust only in CCTP, which already moves the funds |
| `MamoruRegistry` with a 2-of-2 team admin and a 72 h timelock | Eligibility by rule, vault and chain tables in code (I8) | A list someone edits is an admin; rules checkable on chain give the same result with no one holding power (Morpho Blue style) |
| Registry `routes[domain]` flag | Every table chain is a route once readiness is proven | No flag to set |
| Validation reads the registry and the pool (`_checkExit`) | Static validation; price checks in V4's entry points and `checkExit` (I9) | Spec 009 POL-12: public bundlers must be able to take session ops |

What A1 keeps from r2: one signature to create and one per withdrawal, no expiry and no lifetime total, money only to
the user's own Safes, the per-window bucket, the 24 h and 30-day caps, the pinned Safe stack and CCTP, and the
migration.

Spec 009 is amended in the same change: its V-next is this V4, and its POL-02/03/04/11 follow I5/I6 (no expiry, no
lifetime total).

## Review history

The r1–r5 reviews (GPT-6 Sol, PR #196, NO-GO each) are kept for their reasoning. Where an answer relied on the
guardian or the registry, A1 replaces it:

| Review | Finding | Answer then | Answer now (A1) |
|---|---|---|---|
| r1 P0-1 | A registry template can make the remote "Safe" hostile | Stack and initializer are V4 constants | Unchanged |
| r1 P0-2 | The registry can swap CCTP for a drainer | Messenger constant, `localMinter()` check, exact approvals | Unchanged; there is no registry |
| r1 P1-3 | A listed vault can take assets for worthless shares | Factory-verified vaults, exact approvals, vault ratio | Exact vault addresses in the table, exact approvals, vault ratio |
| r1 P1-4 | Migration cannot prove old sessions are gone | Inventory from events, `assertNone` | Unchanged |
| r1 P1-5 | A design-C remote Safe is not migrated | Second prompt on Monad | Unchanged |
| r1 P1-6 | A gas-only userOp policy allows unbounded gas spend | Gas bucket per window | GCRA rate (I6) |
| r1 P1-7 | No justification for dropping the lifetime cap | 30-day cap, breaker, guardian cancel | 24 h and 30-day caps, band-limited extraction, no admin to cancel because no one can add |
| r2 P0-1 | Remote Safe undeployable (attestation at setup) | Self-attested canonical initializer | Unchanged |
| r2 P0-2 | Rebuild from original keys restores a revoked owner | Current owners; burns stop on change | Unchanged |
| r2 P1-3 | Registry-chosen router or NPM | Per-chain tuple pinned | Unchanged |
| r2 P1-4 | Admin-chosen "stable" | Tokens pinned | Unchanged |
| r2 P1-5 | A slow leak repeats with no end | 10C review threshold by the guardian | Accepted as a rate, not a total: 3C per 30 days exposed, about 5.1 % of that extractable; mitigations in the threat model |
| r3 P0-1 | A revoked owner can still drain an old remote | Rotation ceremony, burns stop, alert | Unchanged |
| r3 P0-2 | A burn can target an undeployable remote | Deploy and read back before the first burn | Read-back by `announceReady` on chain, delivered by CCTP |
| r3 P1-3 | Approve/spend pairing | Approvals only to V4 | Unchanged |
| r3 P1-4 | A thin pool's TWAP is not a value bound | Depth check at every priced use | Unchanged |
| r4 P0 | Readiness checked only by the operator | Guardian writes `readyOf` | CCTP message from the destination V4 writes `readyOf` |
| r4 P1 | No cumulative stop on gas | Guardian-reset `GAS_REVIEW` | GCRA rate (I6) |
| r5 P1 | A userOp policy cannot count gas actually paid | Charge at validation from capped fields | Unchanged, charged into the GCRA |

## Open questions

1. ~~T1~~ **Answered** (`results/t1-smartsession-probe-2026-11-02.md`, Base and Monad forks, 13/13):
   - **Fallback action:** supported (`FALLBACK_TARGET_FLAG`). A forbidden target, selector or batch item is refused.
   - **userOp policies:** a gas-policy-only session enables and validates. If a TimeFrame is ever kept, it needs
     `validUntil = 0` with `validAfter ≠ 0`; `(0, 0)` bricks the session.
   - **Migration gas:** remove 3 sessions and enable 1 is 1.23M, against the 14.5M target.
   - **The enable flow** runs `trustAttesters` + a self-attestation by the Safe (764k, once). The remote
     initializer must use the same self-attestation inside its setup: the attester is the remote Safe itself, so
     no third party can revoke it before deployment (r2 P0-1).
   - **ERC-7562:** r2 read the registry at validation and relied on Mamoru bundling its own userOps. A1 removes the
     registry and moves every dynamic read to execution (I9), so T1c re-runs the bundler check.
2. Is a pure-Solidity reconstruction of the canonical initializer (`packages/account/remote`) feasible in
   `registerRemote`, at under ~1M gas? Otherwise V4 takes the initializer as calldata and checks it piece by piece
   against the constants.
3. The class parameters: per-pair ratios (the v6 mix 50/35/15, or a flat maximum), fee sets, and windows per asset.
4. The 24 h cap (C) and the 30-day multiple (3): measure them against the engine's real spend from D1 so that they
   never refuse a normal operation, and lower them where they can be lower.
5. `G` and `W` per chain for the gas rate, from the engine's real gas use (about 0.01 ETH per month on Base today).

## Tasks

- **T1** fork probe: fallback action and a gas-only userOp policy; `removeSession` gas. Done.
- **T1b** fork test of the canonical remote initializer: self-attestation inside setup, deployment after a CCTP
  mint to the counterfactual address, owners/modules/session read back. Before T3.
- **T1c** fork probe (A1): a userOp policy's returned `validAfter`/`validUntil` is intersected by SmartSession and
  enforced by the EntryPoint; a standards-compliant ERC-7562 bundler admits a V4 session op with its `clock`; a CCTP
  V2 message between two V4 instances on forks (Base ↔ Monad, Base ↔ Ethereum) reaches `handleReceiveFinalizedMessage`
  at finality 2000.
- **T2** the per-chain table: pool classes and their parameters, fee sets, the exact vault list, gas `G`/`W`, each
  checked against the hard bounds by a unit test. Replaces the registry task.
- **T3** contract changes to the merged code (#200, #209), A1:
  - `MamoruActionPolicyV4.sol`: remove `GUARDIAN`, `pause`, `unpause`, `review`, `setReady`, the pause state and
    `PAUSE_*`, `REVIEW_MULTIPLE`, `spentSinceReview`; the breaker refuses instead of tripping; read classes, vaults and
    chains from `MamoruV4Chains` instead of `REGISTRY`; per-pair sub-bucket; `announceReady` and
    `handleReceiveFinalizedMessage`; `checkExit` and a static `checkAction`.
  - `MamoruGasPolicyV2.sol`: remove `GUARDIAN`, `review`, `GAS_REVIEW` and the `block.timestamp` bucket; GCRA `tat`
    on the claimed time, with the returned time range. V4 gains `clock(T)`.
  - `MamoruRegistry.sol` and its tests: deleted.
  - `MamoruV4Chains.sol`: classes, vault addresses, gas `G`/`W`; `gasReview` and `vaultFactories` go.
  - `script/DeployV4.s.sol`: no registry, no guardian argument; refuses a source with a guardian or pause path.
  Under EIP-170, CREATE2, the same address on Base, Monad and Ethereum.
- **T4** adversarial suite:
  - V3's LeftClaw tests, ported.
  - A thin pool of pinned tokens on the official factory; a second pool of the same pair (sub-bucket); a fake stable;
    a vault not in the table; a non-canonical factory; a messenger swap.
  - Readiness: a message from a sender other than `address(this)`, from a domain outside the table, from a non-pinned
    transmitter, for a stale `ownersHash`; an `announceReady` for a Safe with the wrong owners, modules or session.
  - `registerRemote` with someone else's commitment; a migration with a stale session.
  - Gas griefing: bursts, many ops in one bundle, idle then burst, a claimed time outside `S`, a batch without
    `clock`; the 24 h and 30-day caps; no pause selector in the bytecode.
  - The worst-case extractable loss per 30 days at maximum class parameters.
- **T5** high-stakes review (GPT-6 Sol, or Opus 5.5 + Gemini 4 Argon), plus an external review if Ot wants one
  before mainnet.
- **T6** operator #293, app #295 and the sibling flow #307 on forks, with the guardian app retired:
  1. create (one screen);
  2. deposit;
  3. the engine enters a pool that became eligible after the account existed, with no signature;
  4. bridge to a table chain after `announceReady`, with no signature;
  5. withdraw (one signature).
- **T7** deploy (Ot's GO in the deploying session): V4, gas policy and migration check on Base, Monad and Ethereum;
  `/ops` #296; beta with Brais's account; then prod. Nothing with a guardian or a registry admin is deployed.
