# 010: One authorization: the owner signs to create and to withdraw, nothing else

Ticket: otto/mamoru#291 (milestone "One authorization": #292 contracts, #293 operator, #294/#295 app, #296 /ops).
Decision: Brais, 1 Nov (chat-mamoru thread "[firma única]"), OK from Ot on 2 Nov, who had asked the same in #281.
Noema `1-projects/mamoru/decisions/2026-11-02-firmar-solo-crear-y-retirar.md`. Status: spec. Nothing built,
nothing deployed.

## Problem

Today a Mamoru account asks its owner for a passkey signature whenever the engine's scope changes:

- **A new pool or vault.** `MamoruActionPolicyV3.Init.pool` binds each config to one pool (`_config[account][pool]`).
  The vault allowlist is fixed in `MamoruV3Routes`' constructor. Anything new means a new Init, so the owner signs.
- **A new chain.** The remote Safe and the bridge-out grant (`mintRecipient EQUAL REMOTE_ACCOUNT`, `grants.ts:375`)
  are fixed when the owner signs (design C, #251). A chain added later needs another owner signature.
- **Expiry and lifetime caps.** These stop the engine without the owner deciding anything:
  - `TimeFramePolicy` runs for 365 days (`policies.ts:51`).
  - `UsageLimitPolicy` caps the number of userOps per approval (36,000 per pool session in v6).
  - V3 `total` caps spend per generation (10 x C_p).
  - The bridge `cumulative` cap applies per approval.
- **Upgrades.** v2 → v6 each needed a signed move, sometimes several transactions (#259: two on a real account).

The owner taps something they do not read, and the engine stops when they don't. Brais's rule: the user trusts
Mamoru once, when creating the account, and signs again only to take money out.

## Decision

Mamoru moves the parts that change (which pools, vaults and chains) out of owner-signed data into an **on-chain,
timelocked registry**. Each account carries **one long-lived session** whose only action policy is
`MamoruActionPolicyV4`, which reads that registry on every check. The owner signs the *rules* once (account cap,
the registry address, where their money may go). Mamoru picks *within* them.

| Owner signature | When |
|---|---|
| Create + authorize | sign-up (one screen, #294; two OS prompts until #116) |
| Withdraw / stop | every withdrawal (owner Safe tx, unchanged: `planTransfer`, `planStop`) |
| Migrate | once, for every account on v2–v6 (the "What's new" screen, #295) |
| New action-policy contract | only if V4 itself must be replaced; optional, and the old one keeps working |

### Invariants (what V4 + the registry guarantee, whatever the registry admin or a session key does)

1. **Funds only ever land in a Safe the owner controls.** Every recipient, CCTP `mintRecipient`, vault receiver
   and owner field is the account itself, or the account's remote Safe on the destination chain (I4). Never a
   third party. *(same as V3, extended to bridges)*
2. **Price.** Every priced action stays within V3's two-TWAP band (the stable pools also within the anchor). The
   band parameters come from the registry entry of the pool, which is timelocked and bounded by the same hard
   limits as V3 Init (`MIN_BAND`..`MAX_BAND`, windows, `MIN_WINDOW_RATIO`).
3. **Positions.** Decrease, collect and burn apply only to positions minted through V4, or admitted at migration,
   that the account still owns. *(V3 unchanged)*
4. **Remote Safe.** Before the bridge can mint to an account's remote Safe, its address is **computed on chain**
   from the owner's own commitment: the passkey (x, y), the owners and the `saltNonce`, in the owner-signed Init.
   The remote setup must be a registry template (Safe singleton, factory, launchpad, the remote V4 and
   SmartSession, the passkey signer), so every candidate address is a Safe whose only owner is the user's
   passkey. No operator input, no Worker, no D1.
5. **Budget.** There is one value budget per account, in USD-stable units. Every registered pool must have a
   budget token in the registry's stable list (USDC, USDT; WMON/USDC and WETH/USDC qualify). It works as a token
   bucket: `perWindow` comes from the owner-signed account cap times a registry ratio, which itself has a hard
   upper bound in V4's code. It has **no lifetime total**. Per-pool limits remain as registry ratios of the
   account bucket, so no single pool can take all of it.
6. **Guardian.** It can pause and unpause, and do nothing else, as in V3. A pause ends with `unpause`. The owner's
   migration signature does not end it. *(V3 ended pauses on renewal, and renewals go away.)*
7. **Additions wait, removals don't.** An entry queued in the registry (pool, vault, stable token, chain route,
   remote template, risk parameters) takes effect only after `DELAY` (72 h). The queue is public: events, and
   `/ops` #296. Removing a pool or vault, disabling a route, tightening a parameter, and `cancel` all take effect
   immediately. Positions in a removed pool stay exit-only (decrease, collect, burn; swap back to the budget
   token within the band).

### MamoruRegistry

- One per chain, no proxy. The admin is a team Safe (default 2 of 2, Ot and Brais, signed offline), and it is
  the only key able to `queue` / `execute` / `cancel`. No upgrade path: replacing the registry is a new V4
  deployment, so it takes a new owner signature (the optional row above).
- **Entries:**
  - `pools[pool]`: twapWindow, shortWindow, band, anchorTick, anchorBand, budgetToken, poolRatioBps.
  - `vaults[vault]`: asset, ratioBps.
  - `stables[token]`.
  - `routes[domain]`: messenger, burnToken, minFinality ≥ 2000, maxFee = 0, and the `remoteTemplate` hash.
  - `templates[hash]`: singleton, factory, fallback/launchpad, remote SmartSession, remote V4, passkey signer,
    and the initializer layout version.
- **Hard bounds in V4, not in the registry:**
  - Every pool comes from the canonical Uniswap v3 factory of the chain.
  - Every vault has `asset()` in the stables list.
  - `DELAY` is an immutable of at least 48 h.
  - Ratios never exceed 10,000 bps of the owner's cap.
  - Band limits are V3's.
  - A route's `burnToken` is a registered stable.
- **Views V4 reads:** `poolParams(pool)` and `vaultAsset(vault)`, both reverting if the entry is not active, and
  `route(domain)`. Each is one SLOAD-heavy call. Measure the validation gas (ERC-7562 already does not apply,
  spec 007).

### MamoruActionPolicyV4

- **V3 kept as is:**
  - The Uniswap checks: price band, admitted positions, `mint`/`increase` through the policy, swap deadline,
    LeftClaw fixes.
  - The guardian.
  - `initializeWithMultiplexer` restricted to `SMART_SESSION`.
  - The setup mode (Init without live reads) for new accounts.
- **Per-pool config replaced:**
  - **Init (owner-signed, account-wide):** `{ capUsd, passkeyX, passkeyY, owners[], saltNonce, admit[], generation }`.
    `owners`/`saltNonce` must reproduce the account's own address with the account's own template (V4 checks
    `computeAddress(...) == account` at enable, so the commitment cannot name someone else's passkey).
  - **Pool params:** taken from the registry at each check, never from the Init.
- **New actions (session-callable, all bounded by I1):**
  - `registerRemote(domain, sessionKey)`: computes the remote Safe from the account's commitment and the
    route's template with that session key, and stores `remoteOf[account][domain]` once. Callable only through
    the account's own session, so only Mamoru's key can call it. Whatever key it names, the Safe it yields is
    owned by the user's passkey alone, and its sessions run the remote V4.
  - CCTP `depositForBurn` to `remoteOf[account][domain]` on a registered route, charged to the account bucket.
  - The vault family: V3's checks against the registry instead of the constructor list.
- **One session per account and chain.** It has a single fallback action (SmartSession's fallback-action flag, any
  target and selector) whose only policy is V4, which decides everything (target, selector, recipient). There are
  no per-token approve actions, no per-pool sessions, and no UniActionPolicy or PauseGate (V4 runs the pause check
  itself).
- **UserOp policies:** `MamoruGasPolicy` (per-op gas) only. No TimeFrame, no UsageLimit.
  - **Verify on a fork** that the deployed SmartSession accepts a session with a fallback action and no
    TimeFrame/UsageLimit (`NoPoliciesSet` requires *some* policy: the gas policy). If it refuses, use TimeFrame
    with `validUntil = 0` (treated as unbounded in our own driver; verify on chain) and a UsageLimit at
    `MAX_USAGE_LIMIT`.

### Migration (v2–v6 → V4, one owner transaction)

- **One Safe transaction:**
  1. Remove every old Mamoru session (`removeSession` for each permissionId the account holds).
  2. Enable the V4 session with the account's commitment and its admitted positions.
- **Gas:** one V3-only session cost ~2.7M; one fallback-action session should be below that. Adding `removeSession`
  for each old session is far under the 14.5M target. Measure it on the largest real account (c23e94e1, b54dda3a
  after #259).
- **Monad:** an account that already has a design-C remote Safe keeps it. `registerRemote` accepts it if its
  address matches the commitment computed with the session key it was set up with. Otherwise the operator
  provisions a new V4 remote Safe and the old one is drained by its own session to the new one, inside I1 (both
  are the user's).
- **The old policies keep working until the owner signs:**
  - A user who taps "Not now" stays on v2–v6 as today, renewals included.
  - Renew rows disappear only for V4 accounts.

### What the operator stops doing (#293)

- **Removed:**
  - `planRenew`, `planExtend`, `prepareRenew`, `settleRenewals`, `renewTarget`, `assertRenewable` and
    `renewRefusal`, and the `'renew'` owner kind.
  - The `V4/V5/V6_MIGRATES_FROM` chains, `upgradeSplitOf`, `missingGrants` and the usage refresh
    (`session-usage.ts`, `USAGE_RENEW_BPS`).
  - `REMOTE_BRIDGE_STOP_SECONDS`.
  - (refs in #291's research note)
- **Kept, now reading from the registry:** activation, the setup-mode create, and the engine's choice of pools
  (`buckets[].pools` resolves against `registry.activePools()`, not the static `V4_POOLS`).

## Threat model

| Who | What they can do | Bound |
|---|---|---|
| Leaked session key | V3's attacks, within the band and the bucket | Same per-window loss as spec 007 (3.6% of cap in minutes, 6.6% in a day), **no lifetime cap**: an unrevoked key keeps losing ~6.6%/day until the guardian pauses. Mitigation: the guardian watches V4 budget burn (ops alert at 2 windows in a row at > 80%), pause in minutes. Owner key rotation = one signature, prompted only after a pause. |
| Leaked registry admin (both keys) | Queue a trap pool (e.g. a factory pool of a stable/attacker token pair with thin liquidity), wait `DELAY`, then drain each account's bucket through it | One pool's ratio of the bucket per window, after ≥ 48 h of public notice. The stables list is timelocked too, so a fake "stable" also waits. Mitigation: `/ops` and an ops alert on every `Queued` event, and a revoke-only `cancel` that the guardian can also call (open question 2). |
| Leaked registry admin + session key | Both of the above at once | Same as the row above; the session key adds nothing past the bucket |
| Compromised operator / Worker | Pick bad pools within the registry, refuse service | Within I1–I5; withdrawal stays owner-only |
| Malicious remote template | Queue a template whose Safe is not the user's | Template fields are checked by V4's hard bounds: the owner of the remote Safe is derived from the user's passkey by `SafeWebAuthnSharedSigner` at a fixed address per chain. A template can only change the singleton/factory/launchpad addresses, and those must be the registry's `templates` entry after `DELAY`. Review this row hardest. |

What the owner gives up compared to V3: per-pool consent, and a lifetime total. What they get: no renewals, no
stoppage at day 365 or at a usage limit, no tap for each new pool or chain.

## Open questions (resolve in review, before #292 code)

1. Does the deployed SmartSession (Base and Monad) support fallback actions, and enable/validate a session with
   only `MamoruGasPolicy` as userOp policy? Fork test first (T1).
2. Who can `cancel` a queued entry: the admin Safe only, or also the guardian (revoke-only key)? Proposal: the
   guardian too. Cancelling only ever restricts.
3. Remote address derivation on chain: the Safe `initializer` includes the session data (with the session key)
   and the passkey `configure`. Is a pure Solidity reconstruction under ~1M gas feasible, and identical to
   `packages/account/remote` byte for byte? If not, `registerRemote` takes the initializer as calldata and V4
   checks it against the template piece by piece.
4. Per-pool ratio defaults: stables 50%, WETH/USDC 35%, WMON/USDC 15% of the bucket (the v6 mix), or a flat
   per-pool max (e.g. 60%)?
5. The guardian pause no longer ends on renewal. Is `unpause` by the guardian enough, or does the owner also need
   an unpause signature (a fifth screen)?

## Tasks

- **T1:** fork probe on Base and Monad: fallback action + gas-policy-only session against the deployed SmartSession;
  `removeSession` cost; validation gas of one registry read.
- **T2:** `MamoruRegistry`: queue/execute/cancel, `DELAY` immutable, hard bounds, events; Foundry tests.
- **T3:** `MamoruActionPolicyV4`: V3 diff (registry-driven pools/vaults, account bucket without total,
  `registerRemote`, bridge family, pause check inside), under EIP-170 (split routes as V3 does).
- **T4:** adversarial suite: V3's LeftClaw tests ported, plus trap pool after DELAY, fake stable, template swap,
  `registerRemote` with someone else's commitment, migration with a stale session left enabled.
- **T5:** high-stakes review (GPT-6 Sol, or Opus 5.5 + Gemini 4 Argon), then an external review if Ot wants one
  before mainnet.
- **T6:** operator #293 and app #295 against V4 on forks; e2e: create (1 screen) → deposit → engine enters a pool
  added to the registry after the account was created, with no signature → bridge to a chain route added later,
  with no signature → withdraw (1 signature).
- **T7:** deploy (Ot's GO in the deploying session): registry + V4 on Base and Monad, `/ops` #296, beta with
  Brais's account (migration via What's new), then prod with every account offered the migration.
