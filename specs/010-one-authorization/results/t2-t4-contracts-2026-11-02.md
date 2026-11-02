# T1b, T2, T3, T4: the contracts of one authorization (spec 010, otto/mamoru#292)

Date 2026-11-02. Branch `feat/292-one-auth-contracts`. Nothing deployed, no live transaction, public archive RPCs only
(`https://mainnet.base.org` at block 53,140,000; `https://rpc.monad.xyz` at block 116,980,000), anvil semantics (Ethereum
gas schedule on both forks: Monad's repricing is not measured). Foundry 1.7.1, solc 0.8.28, cancun.

Run: `cd contracts/action-policy && nix shell nixpkgs#foundry --command ./install.sh` once, then
`nix shell nixpkgs#foundry --command forge test -j 4` (all 413 tests, exit 0). The gas figures below come from
`forge test --isolate --match-path "test/{V4UserOpFork,V4RemoteFork,OneAuthRemoteInitFork}.t.sol" -vv` (each top-level
call its own transaction, cold state, intrinsic gas included where it says "tx").

## What was built

| File | What |
|---|---|
| `src/MamoruRemoteSafe.sol` | `MamoruRemoteInit` (the remote Safe's setup step) and `MamoruRemoteSafe` (encoders of the canonical remote initializer, its factory call and CREATE2 address). |
| `src/MamoruRegistry.sol` | T2: timelocked pools, vaults and routes. |
| `src/MamoruV4Chains.sol` | The per-chain pinned tuple (Base, Monad). |
| `src/MamoruActionPolicyV4.sol` | T3: V4, and `MamoruV4Helper` (V3's price checks, the depth walk, the remote derivation), which V4's constructor creates. |
| `src/MamoruGasPolicyV2.sol` | T3: per-op caps, gas bucket, GAS_REVIEW. |
| `src/MamoruMigrationCheck.sol` | T3: `assertNone` (spec), `assertOnly` and `assertMigrated` (only V4 enabled, and every old id's ENABLE nonce moved). |
| `src/SmartSessionTypes.sol` | SmartSession's structs, as V4 encodes them. |
| `test/OneAuthRemoteInitFork.t.sol` | T1b. |
| `test/MamoruRegistry.t.sol`, `test/MamoruGasPolicyV2.t.sol` | T2, I6 units. |
| `test/V4Fixture.sol`, `test/MamoruActionPolicyV4.t.sol`, `test/V4Budget.t.sol`, `test/V4LeftClaw.t.sol`, `test/V4UserOpFork.t.sol`, `test/V4RemoteFork.t.sol`, `test/V4RemoteParity.t.sol` | T4. |
| `foundry.toml` | V4's file compiles viaIR at 200 runs (stack depth). |
| `SECURITY.md` | V4's threat model, check by check. |

Sizes (runtime, EIP-170 24,576), after review r1 of #200: V4 23,931 (645 to spare; `remoteDeployment` moved to the
helper to make room for the vault cap), helper 21,913, gas policy 6,969, MamoruRemoteInit 1,719, MigrationCheck 2,601.
V4's init code (with the helper and MamoruRemoteInit) 48,192 (EIP-3860 49,152).

## 1. T1b: the canonical remote initializer

Exactly as I4 states: home owners (the passkey shared signer and a recovery EOA), threshold 1, `configure(x, y,
verifiers)`, Safe7579 and SmartSession with one fallback session (a stand-in action policy, MamoruGasPolicy). USDC was
dealt to the counterfactual address first (a CCTP mint's effect; a real attested mint is not reproducible on a fork),
then an unrelated sender deployed it; owners, threshold, (x, y, verifiers), Safe7579 as module and fallback handler,
SmartSession and the session read back, and the session's userOp ran. 12/12 on Base and Monad.

**The self-attestation can happen inside setup, but it is not free of third-party state.** The launchpad's attester
list is calldata of the initializer, which cannot name the address it determines, so a setup step contract is needed
(`SelfAttestRemoteInit` in the test: `ModuleRegistry.attest` from the Safe's context, then the launchpad's three steps
with `attesters = [address(this)]`). That works today (1,275,480 gas). But `attest` calls the resolver of SmartSession's
module record (resolver UID `0xdbca873b…`, resolver `0xF0f46857…`, an EIP-1967 proxy, resolver owner the Rhinestone
attester `0x00000033…`), and the resolver owner can point the UID at any resolver with `setResolver`. The fork test does
that with a resolver that refuses: the self-attested setup reverts, so funds minted to its address wait on Rhinestone
(the r2 P0-1 vector, at the registry level).

**What works, and is used:** `MamoruRemoteInit`, delegatecalled by `Safe.setup`, enables Safe7579 and initializes it
with SmartSession as the only validator and **no ERC-7484 registry** (`RegistryInit(address(0), [], 0)`, so Safe7579
skips every registry check), and SmartSession installs in UNSAFE_ENABLE (no registry check of policies or validator).
The deployment then reads only code and immutable state. Same test, same refusing resolver: it deploys (1,038,061 gas),
and 400 days later too. Ordering: `Safe.setup(owners, threshold, MultiSend, [MamoruRemoteInit.init(sessions),
SafeWebAuthnSharedSigner.configure(x, y, verifiers)], fallbackHandler = Safe7579)`; without the passkey owner, the
setup delegatecalls MamoruRemoteInit directly.

The encoders V4 shares with today's TypeScript (`Safe.setup` arguments, MultiSend packing, `configure`,
`createProxyWithNonce`, the factory's CREATE2) rebuild `test/fixtures/remote-safe-monad.json`'s factory call and
address byte for byte (`V4RemoteParity`). The V4 initializer itself differs from today's design-C one (MamoruRemoteInit
instead of the launchpad, one fallback session); #293 builds the TypeScript twin against `MamoruV4Helper.remoteDeployment`.

## 2. Deviations from the spec, with reasons

1. **Remote setup without the ERC-7484 registry**, not with a self-attestation (§1). Consequence: the remote Safe's
   later module installs by its owner are not registry-checked; the owner is trusted for those anyway. `MamoruRemoteInit`
   is a pinned CREATE2 contract created by V4's constructor (same address on every chain).
2. **V4's spending functions check at execution, not at validation.** `checkAction` admits V4's entry points by
   selector; every V3 check (range, spot, bounds, minimums, M-2) and I2/I5 run inside the function with the account as
   `msg.sender`. No check/act window; a failing check reverts and charges nothing (V3 charged at validation). Validation
   gas of a V4 call is 11k (32k tx with intrinsic).
3. **The swap deadline is an argument of `V4.swap`**, not V3's empty `multicall(deadline, [])` (direct router calls are
   refused by I1).
4. **InitV4 = {capUsd, generation, home, homeDomain, admit[]}**: `home`/`homeDomain` added, so a remote's V4 knows where
   it may bridge back (I4). V4 computes them for the remote; the owner's own Init has `home = 0`.
5. **MAX_CHAINS (4) counts chains per account, the home included**: the registry takes at most 3 routes, and remotes
   cannot register remotes, so "4 x the per-chain bound" holds. The spec's "at most MAX_CHAINS routes" would give 5.
6. **Registry parameters outside V3's hard bounds are refused, not clamped** (by the registry at queue and by V4 at use):
   refusing is the tighter reading.
7. **Pinned chains: Base and Monad only.** Ethereum, Arbitrum, Optimism, Unichain are left out: nothing in the repo pins
   their tuples. A route to them can be queued but V4 refuses it. Monad has one pinned stable (USDC) and one asset (WMON).
8. **Vaults**: MetaMorpho factory v1.0 (`0xA9c3D3a3…`) and v1.1 (`0xFf62A7c2…`) on Base, checked on chain (`isMetaMorpho`
   true for gtUSDCp and steakUSDC on v1.0, `MORPHO()` = Morpho Blue on both); no factory on Monad; Aave not admissible.
9. **Windows**: buckets refill C (ratio x C) per day; the breaker sums 25 hourly periods and the 30-day cap 31 daily ones,
   which always cover at least the last 24 h / 30 days, so the bounds are exact upper bounds. Crossing the breaker or the
   10C threshold does not execute the call and pauses (the pause is written; the call returns 0); crossing a bucket or the
   30-day cap reverts.
10. **Not charged**: bridge (value stays the user's), redeem, decrease/collect/burn (as V3). The spec does not say.
11. **The gas policy is a separate CREATE2 deployment passed to V4's constructor** (V4 creating it too would put V4's
    init code over EIP-3860). V4 checks its guardian is V4's.
12. **Remote gas caps pinned per destination chain** in V4's table: V4_GAS_CAPS / MONAD_GAS_CAPS with a bucket of 0.002
    ETH / 1 MON per day (my choice; GAS_REVIEW as pinned by the spec). A remote's C is its home's C at registration.
13. **Depth walk capped at 64 ticks per direction** (only under-counts: refuses more). At MAX_BAND on a spacing-1 pool
    the uncapped walk would be ~1,000 cold reads.
14. **Registry admin and guardian are immutable** (no rotation): a new admin means a new registry, hence a new V4.
15. **`MamoruMigrationCheck.assertMigrated`** besides the spec's `assertNone`: SmartSession's own `getPermissionIDs` must be
    exactly the V4 session, so an id the inventory missed reverts the migration too, and every old id's ENABLE nonce must
    have moved (the migration revokes them, §7).
17. **Vaults: a live position cap and a hard vault ratio** (review r1 of #200): `MAX_VAULT_RATIO_BPS` = 5,000 in V4 and in
    the registry; a deposit is refused when the account's position in the vault (`previewMint` of its shares) plus the
    deposit would pass ratio x C.
16. A pause (breaker, review, guardian) ends with a renewal (a higher generation), as V3's did.

## 3. Gas

| Operation | Gas |
|---|---|
| Trust + self-attest V4 and MamoruGasPolicyV2 (owner tx, once per migrated account) | 451,344 |
| enableSessions, the V4 fallback session, real Init, no admit (owner tx) | 732,782 |
| Same, one position admitted | 796,170 |
| **Migration tx, v6-shaped account**: removeSession x3 (9 + 9 + 3 actions) + revokeEnableSignature x3 + attest + enable V4 (1 admit) + assertMigrated | **1,728,621** |
| handleOps: swap 1,000 USDC on USDC/cbBTC (approve + V4.swap) | 1,001,496 |
| handleOps: mint (2 approves + V4.mint) | 1,169,874 |
| handleOps: registerRemote | 372,242 |
| handleOps: bridge 100 USDC (approve + V4.bridge) | 450,869 |
| Validation: checkAction, approve(V4) (tx incl. 21k) | 34,085 |
| Validation: checkAction, V4.swap / mint / increase / deposit / redeem / bridge (tx incl. 21k) | 31,673-32,377 |
| Validation: checkAction, NPM decreaseLiquidity (oracle + positions) | 173,324 |
| Validation: MamoruGasPolicyV2.checkUserOpPolicy (tx incl. 21k) | 46,727 |
| registerRemote execution (current owners, initializer, CREATE2 address): open question 2, < 1M | 182,473 |
| Remote Safe deployment through the factory (V4 session enabled in setup) | 1,173,920 |
| T1b: registry-less remote setup / self-attested remote setup | 1,038,061 / 1,275,480 |

Swap and mint execution are the expensive part (V4.swap alone 666k, V4.mint 1.18M, cold): the I2 depth walk runs at
every priced use (two directions, one cold `ticks()` read per boundary) plus V3's oracle reads.

## 4. Tests

| Suite | Tests | Exit |
|---|---|---|
| OneAuthRemoteInitBase / Monad (T1b) | 6 + 6 | 0 |
| MamoruRegistryTest (T2) | 10 | 0 |
| MamoruGasPolicyV2Test | 6 | 0 |
| MamoruActionPolicyV4Test (Base) | 24 | 0 |
| V4BudgetTest (Base) | 6 | 0 |
| V4LeftClawTest + V4LeftClawInvariants (12 runs x 20 calls) | 4 + 3 | 0 |
| V4UserOpForkTest (Base, real SmartSession / EntryPoint) | 11 | 0 |
| V4RemoteForkTest (Base + Monad) | 6 | 0 |
| V4RemoteParityTest (TS fixture) | 2 | 0 |
| **New, total** | **84** | 0 |
| Whole `forge test -j 4` (V1-V3 suites included, unchanged) | 413 | 0 |

T4 checklist: V3's LeftClaw H-1, M-1, M-2 (x2), M-3 (x2), M-4, M-5 (x2), M-6, L-7 ported, plus the invariants; a thin
trap pool after DELAY refused (depth); a non-pinned token pool refused (EURC/USDC); a hostile (non-factory) vault and
Aave's static aToken refused; the registry naming the router, the NPM or the messenger refused, and a route outside the
table refused; approve to anything but V4 refused (directly and at validation); direct router, NPM, messenger, vault,
transfer, self-call, empty call, empty batch, mixed batch refused at validation; a leftover (even unlimited) allowance on
V4 inert; registerRemote with another account's state refused; burn without readiness refused; readiness cleared on an
owner change; a migration with a stale session reverts (assertMigrated and assertNone); an old owner-signed ENABLE
payload re-enables an old session on the first migration (the vector) and is refused after the fix; a migration that
misses one revocation reverts; a hostile curator's own factory vault holds at most ratio x C after four deposits over
96 days; gas griefing hits the bucket (3 ops)
then GAS_REVIEW (19 ops; 0.00988 ETH charged, 0.00053 ETH actually paid); the breaker at C in 24 h; the 10C review; the
rolling 3C over 30 days; the session cannot sign ERC-1271 for the Safe.

## 5. Worst-case loss per day, registry at its loosest

`V4BudgetTest.test_worstCaseDailyLossAtLoosestRegistry`: WETH/USDC 0.3 % with band 500 ticks and ratio 10,000 (the
loosest entry V4 accepts), C = 10,000 USDC, an attacker holding the session key and unlimited capital, everything in one
block (no TWAP moves). Each round the attacker pushes the spot to the edge of V4's range against the account, the
account swaps at the edge price, the attacker pushes back; then the same the other way. V4 stopped it after 5 rounds
(9,498 USDC charged, the bucket's C): **loss 501.55 USDC = 5.0 % of C per day per chain (501 bps)** on the swap path.

The stated bounds (after review r1 of #200):
- **Swaps and positions**: the whole permitted spend, C per 24 h per chain (3C per 30 days, 10C per review, x 4 chains).
- **One listed vault**: the funds at risk in it are at most **ratioBps x C <= C/2 per chain**, a live cap on the position
  (by the vault's own accounting, rounded against the depositor) checked at every deposit. Deposit throughput is not the
  bound. Anyone can create a MetaMorpho vault through the pinned factory, so a hostile curator's vault can be listed by a
  compromised admin whose queue entry the guardian does not cancel within 72 h. The test builds one (the attacker owns,
  curates and allocates it, with an idle USDC market). After four deposit attempts over 96 days, spaced past every
  window, it holds 0.5C (5,000 USDC on C = 10,000). Residual: after the vault reports a loss the account may deposit up
  to the cap again. Each refill stays inside the spend limits, and ops removes the vault at once.

## 6. Open risks

- **Hostile-curator MetaMorpho vault**: now capped at ratio x C <= C/2 held at any time; refills after a reported loss
  remain possible inside the spend limits. A curated vault allowlist in V4 would close it, at the price of the "no
  signature for a new vault" goal.
- **T7 deployment path**: the home enable flow attests V4 and the gas policy, so they must have ModuleRegistry records
  (`deployModule`). ModuleRegistry's code hash differs between Base and Monad (base.json / monad.json): T7 must confirm
  `deployModule` gives the same address on both, or deploy through the deterministic deployer and register the modules.
  The tests use the deterministic deployer (cross-chain) and `deployModule` (single chain) separately.
- **Guardian trust for readiness**: V4 cannot read the remote chain; a compromised guardian can mark V4's own computed
  address ready before it is deployed (funds still land only at the user's canonical Safe address).
- **Gas**: every swap pays the depth walk (handleOps ~1.0M); fine under the 2M call cap at today's bands, a liveness
  issue only at the loosest bands. V4 has 327 bytes of EIP-170 headroom.
- **Not tested here**: a real CCTP attestation and mint (dealt instead); a real curator theft; Monad's gas repricing;
  the TypeScript side of the V4 initializer (#293); a deployment script with pinned init code hashes (T7).
- **Accepted by the spec and unchanged**: a compromised passkey controls every remote until rotated; ERC-7562
  non-compliance (Mamoru bundles its own ops); Circle, Uniswap, Safe, SmartSession and Safe7579 as deployed.

## 7. Operator notes for #293 (the migration transaction)

Build ONE owner Safe transaction (MultiSend 1.4.1, delegatecall), in this order:
1. `SmartSession.removeSession(id)` for every old Mamoru permission id of the account. The inventory comes from
   SmartSession's events, cross-checked with `SmartSession.getPermissionIDs(account)`.
2. `SmartSession.revokeEnableSignature(id)` for every old id (review r1 of #200, P1). `removeSession` leaves the id's
   ENABLE nonce as it is, so an unused owner-signed ENABLE payload from a v2-v6 renewal would re-enable the old session
   later. Revoking bumps `getNonce(id, account)`. The id list is a SUPERSET: every permission id in SmartSession's
   `SessionCreated` events for the Safe, plus every id in accounts.json, whether still enabled or not. Revoking an id
   that never had a payload is harmless (it only bumps a nonce).
3. `ModuleRegistry.trustAttesters` + `attest` for V4 and MamoruGasPolicyV2 (the production enable flow).
4. `SmartSession.enableSessions([the V4 session])`, with the account's positions in `InitV4.admit`.
5. `MamoruMigrationCheck.assertMigrated(account, [V4 permission id], oldIds, noncesBefore)`. `noncesBefore[i]` is
   `SmartSession.getNonce(oldIds[i], account)` read when the transaction is built. The call reverts (and with it the
   Safe transaction) unless V4's session is the only one enabled and every old nonce moved.

Measured: 1,728,621 gas for three old sessions (9 + 9 + 3 actions).

**Rule (review r2 of #200, P1): Mamoru never asks the passkey to sign a SmartSession ENABLE payload.** Checked on
origin/main: `SMART_SESSION_MODE_ENABLE` (packages/account/sessions/index.ts) is used only by the test fixture
packages/scenarios/fixtures/session-op.ts; every owner signature in apps/ and packages/ is a Safe transaction hash
(enableSessions inside execTransaction; remote sessions committed in the Safe setup); an ENABLE digest is a different
EIP-712 hash, so no other owner signature can stand in for one. The set of signed-but-unused payloads is therefore
empty. `packages/account/sessions/no-enable-mode.test.ts` keeps it so: it fails if any non-test file under apps/ or
packages/ (packages/scenarios and fixtures exempt) references the ENABLE mode, `0x01` as a SmartSession signature mode,
or an enable-digest helper. A future multichain-enable design (#230) must revoke by nonce and get its own review first.
Residual covered on chain: an old id that is still enabled but missing from the list reverts the migration through
`assertMigrated` ("the V4 session is the only one enabled").
