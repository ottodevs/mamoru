# 009: User-paid execution, no guardian, hermetic infra, walkaway exit

Ticket: otto/mamoru#256. Status: spec v3 (2026-11-02). Nothing is implemented, deployed or changed in a live grant.

This replaces v1 of this spec (one treasury Safe with human signers, a refill module, and the treasury as guardian).
Ot rejected it: a system that needs human signatures or a custodied guardian key to run normally neither scales nor
matches the product's values. v3 is the result of three research rounds (2026-11-01/02). The reports are in the
noema vault at `1-projects/mamoru/research/autonomous-gas-and-brake-2026-11-01*`:
- round 1: prior art for gas, brakes, treasuries and keys;
- round 2: five model angles: red team (GPT-6 Sol), clean-sheet architecture (Gemini 4 Argon), mechanisms
  (Gemini 3.8 Flash), a code audit of this repo (Claude Opus 5.5), and CROPS / walkaway yardsticks (Claude Sonnet 5.5);
- round 3: on-chain and source checks.

**Answer to "extend or replace":** extend. Safe 1.4.1, Safe7579, SmartSession and immutable Mamoru policies already fit
the premises. What fails them is:
- the guardian;
- the costs the relayer pays for users;
- an owner credential that only works on Mamoru's domain;
- owner actions that only the operator sends;
- year-long sessions;
- an exit guide that covers one chain.

## Constraints (Ot's premises, 2026-11-01)

| # | Premise |
|---|---|
| C1 | Everything that belongs to a user runs on that user's own balances: gas, fees, actions. |
| C2 | Mamoru-side infra (anything outside the user's account) is atomic and hermetic. It is defined only in its deployed version and initialized once with parameters, by one owner or a 2-of-2 at most. After that it is permanent: no admin, no upgrade, no pause, no withdraw. |
| C3 | Infra may be topped up by Mamoru or by anyone, but can only receive and pay for the specific things it exists for. No other way to extract funds. If one holds 100 USDC and is hacked or its funds get stuck, that is a small, accepted loss, bounded by design. |
| C4 | No entity can ever pause, freeze, censor or lock a user: not Mamoru, not a guardian, not a bot, not a multisig. That would make Mamoru a custodian like an exchange; the goal is the opposite. |
| C5 | Follow the Ethereum community's CROPS values (censorship resistance, open source, privacy, security), with Liquity / Morpho Blue style immutability rather than a super-admin. |
| C6 | No piece can be hacked for more than its own small balance. No human signatures in normal operation. No EOA whose leak matters. |

**Honest limit, stated once.** Every EVM transaction is signed by some key, so the system cannot have zero keys. What
it can have is that no key outside the user's own owner credential moves more than the code allows. Mamoru's contracts
also cannot stop censorship by a chain's block producers (Base's sequencer) or a freeze by a token issuer (Circle for
USDC and the CCTP messenger, Coinbase for cbBTC). Those limits are documented (WLK-06) and never claimed away.

## Verified facts (round 3, 2026-11-02)

- **P-256 precompile (RIP-7212 at `0x…0100`) is live on Base, Ethereum and Monad.** A fresh secp256r1 signature
  returns `1`; a tampered one returns empty. A passkey owner verifies on all three chains without the fallback
  verifier.
- **CreateX, the Safe Singleton Factory, the Arachnid deployer and EntryPoint v0.7 have code on all three chains.**
  Same-address deployment is available everywhere.
- **Monad's 10 MON reserve rule applies to EIP-7702-delegated EOAs, not to contracts.** An `eth_call` with state
  overrides on Monad mainnet showed:
  - a plain contract holding 20 MON sends 15 MON (ending at 5) without error;
  - the same code behind a 7702 delegation fails with `reserve balance violation`.
- **Pimlico's public bundler accepts EntryPoint v0.7 on Base (8453), Ethereum (1) and Monad (143)**
  (`eth_supportedEntryPoints`).
- **SmartSession, deployed build v1.0.0** (code hash matches the `f24dddf` artifacts):
  - **Registry.** The ERC-7484 registry is checked only when a session is enabled (`ConfigLib.sol:89,216`), never
    when it is used. Safe7579 checks it on module install only.
  - **ERC-1271.** With empty `erc1271Policies`, session-key ERC-1271 is rejected (`SmartSession.sol:441`). Mamoru
    sets both lists empty (`packages/account/sessions/index.ts:264`).
  - **Usage limits.** UniActionPolicy's `LimitUsage` is cumulative per rule, keyed by config id and account
    (`UniActionPolicy.sol:156-161`). It has no period variant. It is spent at validation, and a re-enable resets it.
  - **Blocked execution modes.** Delegatecall (`SmartSession.sol:308`), `executeUserOp` (`:315`), the try exec type
    (`:281`) and a nested self-`execute` (`PolicyLib.sol:196`) are refused.
  - **Self-calls are not blocked.** Calls to the Safe or Safe7579 (`installModule`, `uninstallModule`,
    `setRegistry`, Safe admin functions) pass if an action policy allows them, so their refusal rests on Mamoru's
    policies (POL-05).
  - **Owner revocation needs no infra.** The owner revokes with `removeSession`, keyed on `msg.sender`
    (`SmartSessionBase.sol:333`), and needs no registry, hook or policy.
- **The relayer EOA has no on-chain authority.** It is not a session signer, not a guardian, and not named in any
  policy (code audit, round 2, C3).

## Invariants (requirements; each has a proof or test task)

| ID | Invariant | Proven by |
|---|---|---|
| INV-1 | **Owner escape.** On every supported chain the user alone can revoke every agent permission and move every transferable asset, through a published path that no Mamoru key, hook, oracle, paymaster, bundler or service can veto. | T13 (CI walkaway on forks, Mamoru services off) |
| INV-2 | **Closed agent authority.** Every effect a session can cause (nested calls, approvals, gas, failed ops) stays inside immutable per-period **and** total limits, an exact expiry and pinned destinations. ERC-1271 by a session is impossible. The agent cannot install, renew or widen authority. | T5, T6, T7 (Foundry fork tests + invariant fuzzing) |
| INV-3 | **No external control of a user.** No Mamoru-side address is, or can become, owner, guardian, executor with unrestricted calls, revoker or account-wide pauser. Accounts still on a guardian-bearing grant are declared non-compliant until migrated. | T3 (registry and bytecode check), T9 (migration ledger) |
| INV-4 | **Hermetic infra.** Every Mamoru infra contract has immutable, verified code and constructor-only configuration, no privileged state change, no upgrade, and pays only fixed recipients for fixed purposes. | T4 (bytecode and constructor check), T11 if any infra contract exists |
| INV-5 | **Finite infra exposure.** For every reachable history (donations, reentrancy, failures, top-ups), the total value an infra version can ever pay out is at most its declared ceiling. | T11 (Halmos + invariant fuzzing), only if a funded contract is built |
| INV-6 | **User-paid accounting.** Every user action and its gas debit that user's own account under an explicit maximum. No Mamoru wallet pays for a user's workload. | T10 (ledger of every relayer send; CI fails on a non-reimbursed user send) |

## Decisions

### D1. No guardian, no pause, anywhere

The next action policy (V-next: V3 as it stands, with the changes in POL-01..08) is deployed **without pause code**.
`GUARDIAN`, `pause`, `unpause`, `pausedAt` and `isPaused` are removed from the source, so a non-zero guardian cannot be
misconfigured at deploy. `MamoruPauseGate` is retired. The brake is the limit itself (POL-02/03) plus the owner's own
revocation (INV-1).

Prior art: every circuit breaker the research found keeps an admin key or a bot role, including ERC-7265, the Wormhole
Governor, the CCIP rate limiter, the Maker ESM, Forta and Hypernative. The systems that really have no admin (Liquity
v1/v2, Morpho Blue) have no pause either. They rely on limits in code and on automatic triggers from on-chain facts.

No loss-latch hook in v1. Two reasons:
- A Safe7579 hook sees `msg.sender = EntryPoint` for owner and session ops alike (`ModuleManager.sol:339`), so it cannot
  gate only the agent.
- A realized-loss check needs oracles, which can be manipulated into false trips.

If one is ever added, it is a SmartSession **policy**, which only applies to session ops. Owner revoke, uninstall and
withdraw must bypass it.

### D2. Every user cost is an account-paid userOp

Every relayer send that is not reimbursed today goes away (inventory from the round-2 audit):

| # | Today | Where | Becomes |
|---|---|---|---|
| G1 | Safe deploy at activation / first transfer, relayer-paid | `operator.ts:4535-4547` | `initCode` in the account's first userOp, paid by the account |
| G2 | Activation `execTransaction` (attesters, self-attest, enable sessions, self-reserve swap), sponsored | `operator.ts:4622` | The same first userOp, owner-signed through Safe7579, account-paid |
| G3 | ETH top-up from the relayer to the user's Safe | `operator.ts:4558-4564` | Removed. The self-reserve swap (`docs/gas-reserve.md`) becomes mandatory |
| G4 | Owner `execTransaction`s (transfer, Stop, renew, revoke), sponsored within `sponsorship.ts` limits | `operator.ts:4507-4528` | Always Safe-paid: an owner userOp, or a SafeTx refund to `tx.origin` |
| G5 | CCTP `receiveMessage` mint on Base | `bridge-out.ts:1567` | Paid from the transfer (CCTP V2 fee or forwarding), or a userOp of the destination Safe. `receiveMessage` is permissionless, so the user can mint it too |
| G6 | CCTP `receiveMessage` mint on Monad | `bridge-monad.ts:630` | Same as G5 |
| G7 | Ethereum bridge-out relayer fallback (L1 Safe deploy + `execTransaction`) | `bridge-out.ts:520-531` | Deleted. The existing userOp path with the Pimlico ERC-20 paymaster, which the owner bounds by allowance (`paymaster.ts:10-12`), is the only path |
| G8 | `handleOps` bundles | `bundler.ts:119,137` | Unchanged: reimbursed in the same transaction to the beneficiary |

The relayer becomes a **dust bundler**:
- It holds no authority (already true) and a float of about one bundle.
- It uses one key per chain, non-exportable in a KMS. Today one `relayer.key` on disk serves three chains
  (`boot.ts:559,583,689`).
- Submission is private by default, so nobody can rewrite the beneficiary. The beneficiary rotates per batch so that
  users are not clustered by one address.
- The public Pimlico bundler (verified on all three chains), or any ERC-7562 bundler, is the fallback. Nothing a user
  needs depends on Mamoru's bundler being up.

### D3. No funded Mamoru infra in v1

After D2 no user cost is paid by Mamoru, so v1 builds **no** treasury, gas tank or paymaster.

**`GasTreasury` (conditional).** It is built only if a cost that genuinely belongs to Mamoru survives D2 (for example
a dust float for the bundler). It then follows TRS-01..07. The relayer's float alone does not justify it: the bundler
is repaid in the same transaction and refilled by hand at most rarely.

**Paymaster (deferred).** An ownerless ERC-20 paymaster for users who hold only USDC is deferred. Without a signer it
needs an on-chain price and a swap to refill its EntryPoint deposit, and those are exactly the manipulable surface C6
forbids. An EntryPoint deposit is also charged when the op reverts, so a shared paymaster becomes a subsidy that one
user can burn for all. Users hold their own gas through the self-reserve swap. On Ethereum, the Pimlico paymaster is
bounded by the owner's allowance.

### D4. The owner never depends on Mamoru

- **Backup owner (mandatory).** Today the only owner is a passkey with `rpId = location.hostname`
  (`apps/mamoru-app/src/web/lib/passkey-sign.ts:72`), and backup owners are refused
  (`apps/mamoru-app/src/api/onboarding/routes.ts:52-53`, `ONB_BACKUP_UNPROVEN`). Without mamoru.lol, its registrar or
  Cloudflare, a user cannot produce an owner signature. Live funds therefore require a second owner that the user
  controls and that does not depend on the domain: a wallet owner proven by a signed challenge (FR-ONB-004), with
  threshold 1-of-2. Existing accounts add it with one passkey-signed `addOwnerWithThreshold`.
- **Owner actions without the operator.** Today every withdraw, Stop and renewal is prepared, checked and sent by the
  operator (`operator.ts:4500-4640`). The app builds and signs SafeTxs and owner userOps client-side from open-source
  code, and the user can send them through any RPC or bundler. The operator may offer to relay. Its refusal never
  blocks.

## Requirements

### Policy V-next (POL)

- **POL-01: No pause.** The deploy script refuses any source that contains a guardian or pause path, and the deployed
  bytecode has no `pause`/`unpause` selector (T3).
- **POL-02: Limits on every family.** Each family (Uniswap, vault, bridge) gets a per-period budget (token bucket:
  capacity `perWindow`, refilled over `budgetWindow` of at least 1 h) **and** a `total` per generation. Today only the
  Uniswap families have one: the vault and bridge families add no amount limit (`MamoruActionPolicyV3.sol:243-244`),
  so V3 alone would drop the bridge caps that UniActionPolicy holds today.
- **POL-03: The total is a lifetime ceiling.** A generation's `total` never refills and can only be lowered. The agent
  cannot renew, widen or reset a grant. Only an owner-signed renewal starts a new generation, and its new `total` is
  shown to the owner as the maximum loss.
- **POL-04: Session expiry of 30 days or less.** TimeFramePolicy `validUntil` is at most 30 days. Today it is 365 days
  (`packages/policy/src/policies.ts:51`, `policies-v4.ts:53`). Renewal is an owner signature (one tap). Consequence:
  each user signs at least once a month.
- **POL-05: Configuration calls refused.** The action policy refuses every call whose target is the account itself, the
  Safe7579 adapter, SmartSession or the registry. That covers `installModule`, `uninstallModule`, `setRegistry`,
  `execTransaction`, owner and threshold changes, `setFallbackHandler`, `setGuard` and `enableModule`. SmartSession
  does not block these on its own (round 3, Q4).
- **POL-06: ERC-1271 off.** `erc1271Policies` and `allowedERC7739Content` stay empty. A test proves a session-key
  `isValidSignature` returns failure.
- **POL-07: Reviewed tokens and venues only.**
  - Approvals are finite and only to pinned spenders.
  - Recipients are pinned to the account.
  - Routers, multicalls and bridges have their nested recipient, token and amount decoded and bounded, as V3 already
    does for CCTP (`depositForBurn`: recipient = account, pinned domain and token, fee 0).
  - Fee-on-transfer, rebasing or callback tokens, and venues behind an upgradeable proxy, stay out, unless the
    third-party upgrade risk is listed per venue.
- **POL-08: Accounting under failure.** Budget spent at validation by an op that reverts later is strictly bounded by
  the same per-period and total limits. It never blocks owner exit.
- **POL-09: Same address on Base, Monad and Ethereum.** CREATE2 with a pinned compiler and `bytecode_hash = none`.
  Per-chain constants live in a `chainid` table in code, and an unknown chain refuses.
- **POL-10: No global operator approval.** `MamoruV4Executor` as designed is not deployed: it needs a global
  `setApprovalForAll` (`contracts/v4-policy/src/MamoruV4Executor.sol:41-50`), so one bug could reach every account's
  positions. v4 ships through `MamoruV4LiquidityPolicy` with per-account calls.

### Guardian retirement and migration (GRD)

- **GRD-01: Retire the key.** `0xA8E6EF87e612fA5c54668Cc1fF0aC809e1321FdD` (immutable in `MamoruActionPolicyV2` on Base
  and Monad) is retired. It is never funded or called, its private key is destroyed, and the retirement is published.
  It can only pause sessions, never move funds, but while any account is on V2, whoever holds it can freeze that
  account's automation, including its exits (`MamoruActionPolicyV2.sol:388,530,560,600-613`).
- **GRD-02: Remove the copy.** Every UI and grant text that promises a guardian pause is removed
  (`operator.ts:2151,2155,2306`, `home.tsx:118,123,1042`).
- **GRD-03: Per-account migration.** Each account moves to V-next at its next owner-signed renewal; the generation jump
  already exists. A ledger lists every account and the policy it runs.
- **GRD-04: Non-compliant until migrated.** While an account runs V2 or uses `MamoruPauseGate`, that account is declared
  non-compliant with C4 on `/ops` and in the walkaway docs. No claim of "no one can pause you" is made while any live
  account runs V2.

### Keys (KEY)

- **KEY-01: Per-account session key.** One session key per account, non-exportable in a KMS or TEE. Today session keys
  are in a 0600 JSON state file (`state.ts:104-105`) with age-encrypted copies on the standby VPS. Those copies go away.
- **KEY-02: Rotation.** Session keys rotate at each renewal. A leaked key is worth at most what remains of its
  generation's `total`, until its expiry.
- **KEY-03: Bundler keys.** One key per chain in a KMS, no authority (INV-3), and dust only.
- **KEY-04: One-off deployers.** Infra deployments use a throwaway key whose only power is the deployment itself.

### Registry and attesters (REG)

- **REG-01: Self-attest every module a grant uses.** That includes SmartSession and UniActionPolicy, which today only
  Rhinestone attests (`packages/account/sessions/index.ts:364-391`). Once every module is self-attested, a revocation
  by Rhinestone cannot block new sessions or renewals. Already true regardless: a registry change never stops an
  enabled session or an owner action, because the registry is checked at enable and install only.
- **REG-02: Deployment availability.** The deploy path (Safe7579 launchpad) also checks the registry at module install
  (`V3SetupFork.t.sol:1163`). If Rhinestone revokes a module, new Safe deployments that install it fail. That is an
  availability risk for new users, not a custody or exit risk. T3 records which modules the launchpad installs and
  which attestation they rely on.

### Walkaway exit (WLK)

- **WLK-01: Full coverage.** `walkawayCalls` (`packages/account/owner/index.ts:40`) and `docs/walkaway.md` cover every
  chain, asset and position a policy can create. Today they cover Base with USDC and cbBTC only. Missing: USDT, WETH,
  EURC/JPYT, ERC-4626 vault shares, the Monad sleeve (Safe on chain 143, WMON/USDC LP), CCTP burns in flight (the
  permissionless `receiveMessage` step) and ETH left on L1.
- **WLK-02: Static frontend.** An open-source static frontend on IPFS with an ENS name builds and signs the exit with
  the backup owner (D4). It needs no Mamoru backend.
- **WLK-03: Tested with Mamoru off.** In CI, on a fork of each chain: Mamoru's operator, relayer, bundler, Worker and
  domain are unreachable, and the user revokes every session and withdraws every asset through a public RPC and a
  public bundler or a plain `execTransaction`.
- **WLK-04: Self-hosted agent (later).** An open-source agent a user can run with their own session key, so that
  Mamoru refusing service stops only Mamoru's offer, never the strategy.
- **WLK-05: Verifiable builds.** Verified source on every chain, reproducible CREATE2 bytecode, code hashes pinned in
  `packages/registry/*.json` (including the `MamoruGasPolicy` Base address, today env-only, `boot.ts:108,126`).
- **WLK-06: What Mamoru cannot guarantee.** The docs state it:
  - Base's sequencer can delay or censor;
  - Circle can upgrade the Base TokenMessenger proxy, withhold attestations or blacklist an address;
  - cbBTC's issuer can freeze it;
  - vault curators may run upgradeable contracts.

### Conditional `GasTreasury` (TRS), only if D3's condition holds

- **TRS-01: Constructor-only configuration.** All configuration goes in constructor arguments: no `initialize`, no
  owner storage, no proxy, `delegatecall` or `selfdestruct`. A front-runner deploying the same initcode first produces
  the same contract.
- **TRS-02: Receive-only.** A plain `receive()`, plus one function, `refill(uint8 i)`, that anyone can call. Only the
  native asset is supported. There is no sweep, rescue or successor.
- **TRS-03: Payout rule.** `refill(i)` pays only `recipients[i]` (fixed list) and only when its balance is below
  `low[i]`. It pays the smallest of:
  - `target[i] − balance`;
  - the token bucket's remaining capacity (not a per-UTC-day cap, which allows twice the amount across midnight);
  - `lifetimeCeiling[i] − paid[i]`.

  It pays nothing below `minTopUp`. State is written before the send, the call forwards limited gas, and a reverting
  recipient never blocks the others. Above `low` it is a no-op (no revert, no event).
- **TRS-04: Lifetime ceiling.** Per recipient and per version (INV-5). When it is reached the version is retired: a new
  version is deployed and the old one runs dry, never reset.
- **TRS-05: Same address on every chain.** CREATE2 with a pinned compiler. Per-chain values live in a `chainid` table,
  and an unknown chain pays nothing. Monad needs no reserve constant for this contract (round-3 fact).
- **TRS-06: Init signature.** The deployment is signed by one owner or a 2-of-2 after a fork test of the exact init
  calldata. That signature is the only human act.
- **TRS-07: Runway alert.** Posts "fondea X en chain Y" when the remaining payout capacity runs low. That alert is the
  only human touch in operation.

## Threats

| Threat | Today | After v3 | Residual |
|---|---|---|---|
| Guardian key leaked or abused | Freezes any V2 account's automation, including exits | No guardian in V-next; key destroyed; V2 accounts flagged until migrated | Unmigrated accounts until renewal |
| Session key leaked | Acts within the grant for 365 days | Per-period + total limits on every family, ≤30 days, per-account key in KMS/TEE | Up to the remaining `total` of one generation |
| Session escapes policy (self-call, module install, ERC-1271, nested router call) | Self-calls not blocked by SmartSession; ERC-1271 empty | POL-05/06/07 with tests | Bugs in V-next (audit, fuzzing) |
| Relayer key leaked | Float on three chains, one key | Dust per chain, KMS, no authority | One bundle's float |
| Mamoru refuses or disappears | No owner signature off-domain; owner actions go through the operator | Backup owner, client-built owner txs, static exit frontend, CI test with Mamoru off | Users who skip the backup owner (blocked from live funds) |
| Rhinestone revokes an attestation | Blocks new enables and renewals of Rhinestone-only modules | Every module self-attested | New Safe deploys through the launchpad (availability) |
| Bug in an infra contract with no admin | n/a (no funded infra) | None funded in v1; conditional `GasTreasury` bounded by lifetime ceiling | Its ceiling |
| Wrong constructor parameters | n/a | Fork test of exact init calldata; bytecode and code-hash check per chain; unknown chain pays nothing | A wrong value stays until the next version |
| Shared V4 executor bug | Undeployed design reaches every account | Not deployed (POL-10) | None |
| Users linked by one beneficiary / shared keys | One relayer address on every bundle | Per-account session keys, rotating beneficiary | On-chain analysis of funding sources |
| Sequencer censorship, issuer freeze | Same | Documented (WLK-06) | Outside Mamoru's contracts |

## Out of scope

- An ownerless paymaster (D3: deferred until it can meet INV-4/5 without an oracle or a swap it can be gamed through).
- A loss-latch hook (D1).
- Cross-chain refuel services.
- Changing the passkey RP ID: it stays as is, and the backup owner solves the dependency.

## Tasks

**P0, no redeploy**
- **T1: Retire the guardian.** Do GRD-01/02: destroy the key, publish the retirement, remove the copy.
- **T2: Backup owner.** Do FR-ONB-004 (signed challenge) and make the backup owner mandatory for live funds, plus the
  one-signature add for existing accounts.
- **T3: Inventory checks.** Make the self-reserve swap mandatory and delete the ETH top-up (G3). Script the bytecode
  and registry checks: no pause selector in V-next, the module and attestation inventory for REG-02, and the pinned
  code hashes.

**P1, one redeploy**
- **T4: V-next.** Implement POL-01..10 from V3, with no pause code and with limits on the vault and bridge families.
  Deploy with CREATE2 to the same address on Base and Monad, and pin it in the registry.
- **T5: Fork tests for the session surface.** Self-calls (each selector in POL-05) are refused. ERC-1271 by a session
  fails. Delegatecall and executor modes are refused. Nested router recipients are bounded.
- **T6: Invariant fuzzing.** The per-period and total limits hold under batching, nonce races, reverting ops and
  re-enable. POL-03: no path raises a generation's `total`.
- **T7: Renewal.** The renewal flow moves accounts off V2 and `MamoruPauseGate` (GRD-03) and sets expiry ≤30 days
  (POL-04).
- **T8: Self-attestation.** Self-attest SmartSession and UniActionPolicy (REG-01).
- **T9: Migration ledger.** The ledger of accounts and the policies they run, plus the GRD-04 flag on `/ops`.

**P2, user-paid execution**
- **T10: Account-paid sends.** Turn G1, G2 and G4 into account-paid userOps, G5 and G6 into transfer-paid or
  destination-userOp mints, and delete G7. Add a CI ledger check: any relayer send that is not a `handleOps` bundle
  fails the build (INV-6).
- **T11: Bundler.** Relayer keys per chain in KMS, private submission with a public-bundler fallback, rotating
  beneficiary. Build `GasTreasury` (TRS-01..07, with Halmos and fuzzing for INV-5) only if D3's condition holds.

**P3, keys and exit**
- **T12: Session keys.** Session keys in KMS/TEE, per account. Delete the plaintext state copies and the standby VPS
  key bundles.
- **T13: Walkaway.** Do WLK-01..03 and WLK-05: full coverage, IPFS/ENS frontend, CI on forks of all three chains with
  Mamoru off.
- **T14: Self-hosted agent.** WLK-04 (later).

## Scenarios

- **S1: Leaked session key.** A leaked session key drains as fast as it can. Loss is at most the remaining `total` of
  the generation, never more after expiry, and only to pinned destinations.
- **S2: Mamoru disappears.** Domain, Worker, operator and bundler are all gone. The user opens the IPFS frontend, signs
  with the backup owner, revokes every session and withdraws every asset on Base, Monad and Ethereum through public
  infrastructure.
- **S3: Leaked guardian key.** Someone holds the retired guardian key. No V-next account can be paused. V2 accounts are
  listed as non-compliant until renewed.
- **S4: Policy surface.** A session tries `installModule`, `setRegistry`, `execTransaction`, ERC-1271 and a router call
  with a foreign recipient. All are refused.
- **S5: Rhinestone revokes.** Existing sessions and owner actions continue. New sessions continue for self-attested
  modules.
- **S6: Relayer key leaked.** Loss is one bundle's float on one chain. No user is affected.
- **S7: No relayer-paid user sends.** CI finds a relayer send for a user action outside `handleOps`, and the build fails.
