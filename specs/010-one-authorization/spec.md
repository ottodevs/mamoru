# 010: One authorization: the owner signs to create and to withdraw, nothing else

Ticket: otto/mamoru#291 (milestone "One authorization": #292 contracts, #293 operator, #294/#295 app, #296 /ops).
Decision: Brais, 1 Nov (chat-mamoru thread "[firma única]"), OK from Ot on 2 Nov, who had asked the same in #281.
Noema `1-projects/mamoru/decisions/2026-11-02-firmar-solo-crear-y-retirar.md`. Status: spec r2. r1 got NO-GO
from GPT-6 Sol on PR #196 (2 P0, 5 P1); every finding is addressed below and listed in "Review r1". Nothing built,
nothing deployed.

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

Mamoru moves the parts that change (which pools and vaults, which chains) out of owner-signed data into an
**on-chain, timelocked registry**. Each account carries **one long-lived session** whose only action policy is
`MamoruActionPolicyV4`, which reads the registry. The owner signs the *rules* once. Mamoru picks *within* them.
Everything that could move money to someone else (the Safe stack, CCTP, the shape of the remote account) is
**pinned in V4's code**, never in the registry. The registry can only choose among things V4 already trusts, and
size them within V4's hard bounds.

| Owner signature | When |
|---|---|
| Create + authorize | sign-up (one screen, #294; two OS prompts until #116) |
| Withdraw / stop | every withdrawal (owner Safe tx, unchanged: `planTransfer`, `planStop`) |
| Migrate | once, for every account on v2–v6 (the "What's new" screen, #295); a second prompt only for an account that already has a design-C remote Safe |
| New action-policy contract | only if V4 itself must be replaced; optional, and the old one keeps working |

### Pinned in V4 (constructor-free constants, identical bytecode on every chain)

V4, its routes helper and the registry are deployed with **CREATE2 through the canonical deterministic deployer**,
with **chain-independent init code**. The same address therefore implies the same code on every EVM chain, so a
policy on Base can reason about what lives at an address on Monad. Constants:

- **Safe stack:** SafeL2 1.4.1 singleton, SafeProxyFactory 1.4.1, MultiSend 1.4.1, Safe7579 adapter + launchpad,
  `SafeWebAuthnSharedSigner`, and the SmartSession. All of these are canonical CREATE2 deployments already at the
  same address on Base and Monad (`base.json` / `monad.json`). V4 also checks at enable that each one has code on
  the local chain, with the expected `EXTCODEHASH`.
- **`address(this)`** (the remote V4) and **`REGISTRY`**: both CREATE2, both the same on every chain.
- **CCTP:** the canonical `TokenMessengerV2` address (the same on every chain Circle supports: verify on
  Base and Monad in T1). The burn token is
  not a constant. V4 accepts a token only if the canonical messenger's own `localMinter()` accepts it as burnable
  (non-zero burn limit). The token is therefore Circle's, whatever the registry says.
- **Per-chain tuple, keyed by `block.chainid`:**
  - The tuple: Uniswap v3 factory, NPM, SwapRouter02, the stable tokens (native USDC, USDT) and the assets (WETH,
    cbBTC, WMON...).
  - Chains: Base, Monad and Ethereum, plus the chains Mamoru may plausibly add (Arbitrum, Optimism, Unichain),
    each checked against the official deployments.
  - The registry never supplies any of it (r2 P1). A chain or an asset outside the table means a new V4: the
    optional signature.
- **Assets:** every pool is `factory.getPool(t0, t1, fee) == pool`, as in V3, with one side a pinned stable (the
  budget token) and the other a pinned stable or a pinned asset. The registry chooses *which* of these pools, and
  their parameters. It cannot list a token (r2 P1: no "stable" chosen by the admin).
- **Hard bounds on everything the registry may set:**
  - The band, window and anchor limits of V3.
  - `ratioBps ≤ 10,000`.
  - `DELAY` of at least 48 h.
  - `MAX_CHAINS = 4` (each chain's bucket is separate, so the worst case is 4 x the per-chain bound, stated below).

### Invariants

1. **Funds only ever land in a Safe the owner controls.** Every recipient, receiver, owner field and CCTP
   `mintRecipient` is the account itself, or `remoteOf(account, domain)` (I4). Approvals go only to the pinned
   router, NPM via V4's `mint`/`increase`, the pinned messenger, or a listed vault, and always **for the exact
   amount of the next call in the same batch**: V4 refuses an `approve` not immediately followed by the call that
   spends it.
2. **Price.** V3's two-TWAP band (plus the anchor on stable pools), with parameters from the registry entry, which
   V4 clamps to V3's hard bounds.
3. **Positions.** As V3: only positions minted through V4, or admitted at migration, that the account still owns.
4. **Remote Safe.** `remoteOf(account, domain)` is computed **inside V4** from:
   - **The account's current owners**, read on chain at `registerRemote`: `Safe.getOwners()`, the threshold, and
     `SafeWebAuthnSharedSigner`'s current (x, y) configuration for the account. These are never the original
     initializer, so a rotated or removed key is not carried over (r2 P0).
   - **A salt** of `keccak(account, domain, ownersHash)`.
   - **V4's own canonical initializer.** It is a plain Safe setup (owners, threshold, the shared-signer
     `configure`) plus the 7579 adapter and the SmartSession, installed with the account's **own self-attestation** as the only trusted attester (the production enable flow,
     T1). No third party can revoke it, so deployment depends on nothing that can change after a mint: anyone can
     deploy the address at any time through the permissionless factory, and the result is always the user's Safe
     (r2 P0). T4 tests deploy-after-mint on a fork.

   V4 stores `ownersHash` with the remote and refuses every burn while the account's current owners hash differs.
   `registerRemote` may then compute a new remote. The old remote's own V4 sends its funds back only to the home
   account, its fixed `homeOf`. The result is a Safe with the same code as every Mamoru Safe, owned by the user's
   current keys. Its one session is bound by the same V4, and the registry has no say in it.
   `registerRemote(domain, sessionKey)` is only callable through the account's own session.
5. **Budget.** Per chain, one value bucket for the account, in USD-stable units, refilled each window, with:
   - **Per pool and per vault:** at most `ratioBps` of the bucket.
   - **A rolling 30-day cap** of `3 x capUsd` per chain on spend (it replaces the per-approval lifetime `total`:
     it bounds loss in any 30 days and never ends the authorization).
   - **An on-chain circuit breaker:** if spend in 24 h exceeds `capUsd x 1.0`, V4 pauses the account by itself
     until the guardian unpauses.
   - **A cumulative review threshold** (r2 P1): spend since the guardian's last `review(account)` is counted. At
     `10 x capUsd` per chain, V4 pauses the account until the guardian reviews it, checks the ledger and resets
     the counter. A slow leak below the 24 h breaker therefore stops after at most 10C per chain, and in normal
     operation this costs the user nothing (ops reviews it; it never asks the owner).
6. **Gas.** `MamoruGasPolicyV2` (userOp policy) keeps the per-op cap and adds a per-account **gas bucket per
   window**. No action-free userOp: V4 refuses an empty batch and a call it cannot classify, through the
   fallback action.
7. **Guardian.** It can pause, unpause, and **cancel any queued registry entry**. It can never add, enable or move
   a token.
8. **Additions wait, removals don't.** Pool, vault, chain route and parameter changes take effect after `DELAY`
   (72 h) and are public (events, `/ops` #296, ops alert on every `Queued`). Removal, tightening and cancel take
   effect immediately. Positions in a removed pool are exit-only.

### MamoruRegistry

- **Shape:**
  - One per chain, at the same CREATE2 address, with no proxy.
  - The admin is a team Safe (2 of 2, Ot and Brais, signed offline): `queue`, `execute` and `cancel`.
  - The guardian: `cancel` only.
- **Entries:**
  - `pools[pool]`: twapWindow, shortWindow, band, anchor, ratioBps. The tokens must be pinned (above). The budget
    token is the pinned stable side.
  - `vaults[vault]`: ratioBps.
  - `routes[domain]`: an on/off flag only (the messenger, the tuple of the destination chain and the remote stack
    are V4 constants), with `domain` ≠ local, the destination chain present in V4's table, and at most
    `MAX_CHAINS` routes.
- **Vaults** (r1 finding 3):
  - A vault qualifies only if its `asset()` is a pinned stable **and** it is created by a factory from a
    constant list in V4: the MetaMorpho factory's `isMetaMorpho(vault)`, and Aave's wrapper factory (its membership
    view, to be verified in T2; until then, Aave vaults are not admissible).
  - Deposits are charged to the bucket and capped by the vault's ratio.
  - An approval to a vault is exact and spent in the same batch (I1).

### MamoruActionPolicyV4

- **V3 kept:**
  - The Uniswap checks: band, admitted positions, `mint`/`increase` through the policy, swap deadline, LeftClaw
    fixes.
  - `initializeWithMultiplexer` only from `SMART_SESSION`.
  - The setup mode for new accounts.
- **Init (owner-signed, account-wide):** `{ capUsd, admit[], generation }`. Owners come from the account's state
  on chain, never from the Init.
- **The pause check runs inside V4** (no PauseGate). The circuit breaker writes the same pause.
- **One session per account and chain:**
  - A single fallback action whose only policy is V4.
  - The userOp policy is `MamoruGasPolicyV2` only.
  - T1 (fork probe) confirms the deployed SmartSession supports this. If not: one action per pinned target and
    selector (the target set is finite: router, NPM, V4, messenger, the stables, the listed vaults), and
    `TimeFramePolicy(validUntil = 0)`, if T1 shows 0 means no bound.

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
  sessions are removed. No old policy is ever called again.
- **Design-C remote Safes** (r1 finding 5; today one account, b54dda3a):
  - They cannot be migrated from Base. Their bridge stop (`REMOTE_BRIDGE_STOP_SECONDS`) stays until they are
    migrated.
  - The migration screen asks a second passkey prompt, on Monad, that:
    1. removes the remote V3 sessions;
    2. enables V4;
    3. moves the remote Safe's funds to `remoteOf(account, 15)` if that is a different address. Both Safes
       belong to the user.
  - No new design-C remote Safe is created after V4 ships (`multichain_v6` stays scoped).
- **A user who taps "Not now"** stays on v2–v6, renewals included.

### What the operator stops doing (#293)

- **Removed:**
  - The renew/extend/upgrade family: `planRenew`, `planExtend`, `prepareRenew`, `settleRenewals`, `renewTarget`,
    `assertRenewable`, `renewRefusal`, and the `'renew'` owner kind.
  - The `V*_MIGRATES_FROM` chains, `upgradeSplitOf` and `missingGrants`.
  - The usage refresh.
  - This applies to V4 accounts only.
- **Changed:** the engine's pools resolve against `registry.activePools()`.

## Threat model (r2)

Worst case per chain, with V4's hard bounds and `capUsd = C`:

| Who | What they can do | Bound |
|---|---|---|
| Leaked session key | V3's attacks within the band and the bucket, on any listed pool or vault | Per window: the bucket share of the pool; 24 h: at most C before the breaker pauses; 30 days: at most 3C spent, of which the loss is the band slippage share. Spec 007's measured loss (6.6 % of cap per day) holds per pool at today's parameters. Under V4's maximum band (500 ticks) the per-day loss bound is T4's job to state on a fork, before #292 merges. |
| Leaked session key, gas | Repeated no-op or tiny userOps paid by the Safe | The gas bucket per window (`MamoruGasPolicyV2`); the empty batch is refused. |
| Leaked registry admin (both keys) | Queue a thin pool of pinned tokens, a factory-verified vault, looser parameters within V4's bounds | Each waits 72 h in public, and the guardian (a separate key) can cancel it. After the delay: one pool's share of the bucket per window, at band slippage on pinned assets, inside the breaker, the 30-day cap and the 10C review threshold. It **cannot** list a token, a router, an NPM, a messenger, a Safe stack or a remote account: all of those are V4 constants (r1 P0, r2 P1). |
| Leaked registry admin + session key | The row above, at once | Same bounds: the session key adds nothing past the bucket. |
| Compromised operator / Worker | Pick bad pools within the registry, refuse service | Within I1–I6. Withdrawal stays owner-only. |
| A new chain | Admin enables a route to a domain | Funds mint only at `remoteOf`, a canonical Mamoru Safe owned by the user's passkey, bound by the same V4. A chain without the canonical deployer, or with different CREATE2 semantics, cannot host V4 at the pinned address, so its route cannot work. The risk is a non-EVM-equivalent chain where the same address runs different code: the route list is therefore capped (`MAX_CHAINS`) and every addition is timelocked. |

What the owner gives up compared to V3: per-pool consent and a per-approval total. What they get: no renewals, no
stop at day 365 or at a usage limit, no tap for each new pool or chain. The 30-day cap and the breaker are hard
bounds that do not end the authorization.

## Review r1 (GPT-6 Sol, PR #196, NO-GO) → r2

| # | Finding | r2 |
|---|---|---|
| P0-1 | A registry template can make the remote "Safe" hostile | No template in the registry: the Safe stack and the initializer are V4 constants, identical bytecode on every chain (CREATE2), with `EXTCODEHASH` checked locally at enable (I4). |
| P0-2 | The registry can swap CCTP for a drainer | The messenger is a constant; the burn token must be accepted by the canonical messenger's `localMinter()`; approvals are exact and spent in the same batch (I1). |
| P1-3 | A listed vault can take assets for worthless shares | Factory-verified vaults only (MetaMorpho, Aave static aToken), exact approvals, exposure capped by the vault ratio. |
| P1-4 | Migration cannot prove old sessions are gone | Inventory from SmartSession events, fail closed, and an `assertNone` check inside the migration transaction. |
| P1-5 | A design-C remote Safe is not migrated | A second prompt on Monad for those accounts; the bridge stop stays until then; no new design-C Safes. |
| P1-6 | A gas-only userOp policy allows unbounded gas spend | `MamoruGasPolicyV2` with a gas bucket per window; empty or unclassifiable calls refused. |
| P1-7 | No justification for dropping the lifetime cap | A rolling 30-day cap (3C) and an on-chain breaker (C in 24 h), per chain; `MAX_CHAINS = 4`; the worst-case loss under maximum registry parameters is a T4 deliverable; guardian cancel is mandatory. |

## Review r2 (GPT-6 Sol, PR #196, NO-GO) → r3

| # | Finding | r3 |
|---|---|---|
| P0-1 | Funds can be minted to a remote Safe that cannot be deployed: the ERC-7484 attestation is checked at setup | The canonical initializer trusts only the remote Safe's own self-attestation (as in production, T1), so no third party can make it undeployable; T4 tests deploy-after-mint (I4). |
| P0-2 | Rebuilding the address from the original keys can restore a revoked owner | The owners and the passkey are read from the account's *current* state; burns stop when they change; the old remote returns funds home (I4). |
| P1-3 | A registry-chosen router or NPM can take approved assets | A per-chain tuple pinned in V4: factory, NPM, router, stables, assets. |
| P1-4 | An admin-chosen "stable" makes the loss bound meaningless | Tokens are pinned in V4; the registry chooses pools only among them. |
| P1-5 | A slow leak repeats with no end | A 10C cumulative review threshold per chain pauses until the guardian reviews. |

## Open questions

1. ~~T1~~ **Answered** (`results/t1-smartsession-probe-2026-11-02.md`, Base and Monad forks, 13/13):
   - **Fallback action:** supported (`FALLBACK_TARGET_FLAG`). A forbidden target, selector or batch item is refused.
   - **userOp policies:** a gas-policy-only session enables and validates. If a TimeFrame is ever kept, it needs
     `validUntil = 0` with `validAfter ≠ 0`; `(0, 0)` bricks the session.
   - **Migration gas:** remove 3 sessions and enable 1 is 1.23M, against the 14.5M target.
   - **The enable flow** runs `trustAttesters` + a self-attestation by the Safe (764k, once). The remote
     initializer must use the same self-attestation inside its setup: the attester is the remote Safe itself, so
     no third party can revoke it before deployment (r2 P0-1).
   - **ERC-7562:** the registry read at validation breaks unstaked-entity storage rules. Mamoru bundles its own
     userOps, as spec 007 already accepts. V4 keys its own state by account where it can.
2. Is a pure-Solidity reconstruction of the canonical initializer (`packages/account/remote`) feasible in
   `registerRemote`, at under ~1M gas? Otherwise V4 takes the initializer as calldata and checks it piece by piece
   against the constants.
3. The default per-pool ratios: the v6 mix (50/35/15) or a flat maximum?
4. The breaker threshold (C in 24 h) and the 30-day multiple (3): measure them against the engine's real spend
   from D1 so that the breaker never fires in normal operation.

## Tasks

- **T1** fork probe: fallback action and a gas-only userOp policy; `removeSession` gas; registry read gas.
- **T2** `MamoruRegistry` (queue/execute/cancel, guardian cancel, bounds, events).
- **T3** `MamoruActionPolicyV4` + `MamoruGasPolicyV2` + `MamoruMigrationCheck`, deployed by CREATE2, under
  EIP-170.
- **T4** adversarial suite:
  - V3's LeftClaw tests, ported.
  - A trap pool after the delay; a fake stable; a hostile vault; a non-canonical factory; a messenger swap.
  - `registerRemote` with someone else's commitment; a migration with a stale session.
  - Gas griefing; the breaker.
  - The worst-case loss per day at maximum parameters.
- **T5** high-stakes review (GPT-6 Sol, or Opus 5.5 + Gemini 4 Argon), plus an external review if Ot wants one
  before mainnet.
- **T6** operator #293 and app #295 on forks. End-to-end:
  1. create (one screen);
  2. deposit;
  3. the engine enters a pool added after the account existed, with no signature;
  4. bridge to a chain route added later, with no signature;
  5. withdraw (one signature).
- **T7** deploy (Ot's GO in the deploying session): registry, V4 and gas policy on Base and Monad; `/ops` #296;
  beta with Brais's account; then prod.
