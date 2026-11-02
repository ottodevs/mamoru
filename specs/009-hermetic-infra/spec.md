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

**Scope of C4 and C6.** C6's "no human signatures" applies to Mamoru's side: infra and operations never wait on a
Mamoru signer. A signature by the user over their own account (a grant, a renewal, a withdrawal) is the user exercising
custody, not a bottleneck. C4 covers the user's account and assets. Mamoru stopping its own hosted agent is Mamoru
withdrawing an offer, not a lock, provided the user can always grant a session to an agent of their choice (WLK-04).

**Honest limit, stated once.** Every EVM transaction is signed by some key, so the system cannot have zero keys. What
it can have is that no key outside the user's own owner credential moves more than the code allows. Mamoru's contracts
also cannot stop censorship by a chain's block producers (Base's sequencer) or a freeze by a token issuer (Circle for
USDC and the CCTP messenger, Coinbase for cbBTC). Those limits are documented (WLK-06) and never claimed away.

**Hosted-agent aggregate exposure.** While Mamoru hosts the agent, one signing service holds many accounts' session
keys. A compromise of that service, rather than of one key, can spend the remaining `total` of every account it
serves. No on-chain mechanism caps a sum across independent accounts. The bound is therefore the sum of the remaining
per-account totals and gas ceilings. KEY-05 publishes that bound, per account and in aggregate, and keeps it attested.
A shared on-chain global limit is rejected (KEY-06). The optional self-hosted agent mode (WLK-04, later) removes a
user from that sum.

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
| INV-1 | **Owner escape.** On every supported chain the user alone can revoke every agent permission and move every transferable asset, through a published path that no Mamoru key, hook, oracle, paymaster, bundler or service can veto. The one dependency left is control of the `mamoru.lol` RP ID for passkey signing, mitigated by D4-R1..R3 and disclosed as D4-R4 for accounts without the optional backup owner. | T13 (CI walkaway on forks, Mamoru services off) |
| INV-2 | **Closed agent authority.** Every effect a session can cause (nested calls, approvals, gas, failed ops) stays inside immutable per-period **and** total limits, an exact expiry and pinned destinations. ERC-1271 by a session is impossible. The agent cannot install, renew or widen authority. | T5, T6, T7 (Foundry fork tests + invariant fuzzing) |
| INV-3 | **No external control of a user.** No Mamoru-side address is, or can become, owner, guardian, executor with unrestricted calls, revoker or account-wide pauser. Accounts still on a guardian-bearing grant are declared non-compliant until migrated. | T9 (per-account state check: owners, threshold, guard, fallback handler, modules, executors, attesters, policy version; any Mamoru address in an authority slot fails) |
| INV-4 | **Hermetic infra.** Every Mamoru infra contract has immutable, verified code and constructor-only configuration, no privileged state change, no upgrade, and pays only fixed recipients for fixed purposes. | T3 (inventory of every Mamoru-deployed contract on every chain: V1, V2, V3/V-next, MamoruGasPolicy, MamoruPauseGate, MamoruV3Routes, MamoruV4LiquidityPolicy; entry-point analysis of each for privileged or value-moving paths), T11 if a funded contract is built |
| INV-5 | **Finite infra exposure.** For every reachable history (donations, reentrancy, failures, top-ups), the total value an infra version can ever pay out is at most its declared ceiling. | T11 (Halmos + invariant fuzzing), only if a funded contract is built |
| INV-6 | **User-paid accounting.** Every user action and its gas debit that user's own account under an explicit maximum. No Mamoru wallet pays for a user's workload, except the bounded, disclosed reverted-bundle budget below. | T10 (payer trace per user cost: the payer is the user's Safe, the user's own wallet, or a third-party paymaster bounded by an owner-signed allowance; never a Mamoru wallet or a Mamoru-funded paymaster; per userOp, `UserOperationEvent.sender` is the user's account and `actualGasCost` is charged to it or to an admitted third-party paymaster, Mamoru's bundler submits **one userOp per bundle**, so the bundle's whole cost (gas × price, intrinsic overhead and, on Base, the L1 data fee) is attributable to that one user: per bundle, the beneficiary is a declared Mamoru beneficiary for that chain and the submitter's total fee ≤ that op's `actualGasCost` + a per-chain tolerance stated in wei. Admission before submission: simulation, and `preVerificationGas` covering the estimated L1 data fee with a margin. A bundle that reverts on chain (for example a nonce raced through a public bundler) emits no event: its fee is a disclosed exception, counted and capped per account per day, after which the bundler stops submitting for that account. A per-chain global daily wei budget is a hard ceiling on every counted revert on that chain, because fresh accounts cost nothing. Reverts the bundler causes itself (for example its own private-to-public fallback racing a pending transaction) count against it too; they are excluded only from the account's own cap. Once the budget is spent, Mamoru's bundler submits nothing that can revert at Mamoru's cost on that chain until the window resets. This limits only what Mamoru's own bundler takes on, never a user:
  - owner ops still go through any public ERC-7562 bundler, paid by the Safe, and the app routes them there automatically when Mamoru's bundler declines (passkey-only users have no EOA);
  - owner ops can also go as a plain `execTransaction`, paid by the submitting wallet unless a SafeTx refund is used;
  - session ops can still go through a direct `handleOps` from any EOA (the user's own, or a self-hosted agent's).

  The user pays in every case. Disclosed degradation: an attacker who drains the budget each day can stop Mamoru's bundler, and with it Mamoru's hosted automation, on that chain until the reset. Funds and exits are not affected; funding provenance: no transfer from any Mamoru wallet to a user account or to a paymaster that serves users) |

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
| G1 | Safe deploy at activation / first transfer, relayer-paid | `operator.ts:4535-4547` | `initCode` in the account's first userOp, paid by the account (see "First operation" below) |
| G2 | Activation `execTransaction` (attesters, self-attest, enable sessions, self-reserve swap), sponsored | `operator.ts:4622` | The same first userOp, owner-signed through Safe7579, account-paid |
| G3 | ETH top-up from the relayer to the user's Safe | `operator.ts:4558-4564` | Removed. The self-reserve swap (`docs/gas-reserve.md`) becomes mandatory |
| G4 | Owner `execTransaction`s (transfer, Stop, renew, revoke), sponsored within `sponsorship.ts` limits | `operator.ts:4507-4528` | Always Safe-paid: an owner userOp, or a SafeTx refund to `tx.origin` |
| G5 | CCTP `receiveMessage` mint on Base | `bridge-out.ts:1567` | A userOp of the destination Safe, paid from its own gas reserve. Burns keep `destinationCaller = 0` (POL-07), so `receiveMessage` stays callable by anyone, including the user. The pinned zero CCTP fee stays: no fee-paid mint. Circle's forwarding service is unverified for these routes and not relied on |
| G6 | CCTP `receiveMessage` mint on Monad | `bridge-monad.ts:630` | Same as G5. The Monad Safe keeps its own MON reserve |
| G7 | Ethereum bridge-out relayer fallback (L1 Safe deploy + `execTransaction`) | `bridge-out.ts:520-531` | Deleted. The automated path is the existing userOp with the Pimlico ERC-20 paymaster, bounded by the owner's allowance (`paymaster.ts:10-12`). The **owner** path never depends on it (D4: backup owner EOA or SafeTx refund) |
| G8 | `handleOps` bundles | `bundler.ts:119,137` | Unchanged: reimbursed in the same transaction to the beneficiary |

**First operation.** ERC-4337 takes the prefund during validation, before any swap in the batch runs, so a Safe holding
only USDC cannot pay for its own first userOp. The first operation is paid in one of two ways, and the app offers both:
- **(a) Native gas in the deposit.** The user's deposit to the counterfactual address includes native gas: a small
  ETH or MON amount the app states before the user sends.
- **(b) Third-party ERC-20 paymaster.** The first userOp uses the Pimlico ERC-20 paymaster. The owner signs the USDC
  allowance in the same op's callData, and the paymaster pulls it in `postOp`.

(b) is a third-party service whose loss to the user is bounded by that allowance. If Pimlico refuses, (a) remains. No
Mamoru wallet pays.

**Session ops and ERC-7562.** V3's validation reads the pool oracle, the position manager and `block.timestamp`
(`MamoruActionPolicyV3.sol:302-305`), which ERC-7562 public mempools reject. Session ops are therefore submitted by a
direct `handleOps` call. Any EOA can make that call (Mamoru's bundler, a self-hosted agent, the user), so it needs no
public mempool. The public-bundler fallback applies to **owner** ops (exit, revoke, renew), whose validators (owner
signature, WebAuthn through the P-256 precompile) must stay ERC-7562 compliant. T5 tests this through a
standards-compliant bundler.

The relayer becomes a **dust bundler**:
- It holds no authority (already true) and a float of about one bundle.
- It uses one key per chain, non-exportable in a KMS. Today one `relayer.key` on disk serves three chains
  (`boot.ts:559,583,689`).
- Submission is private by default, so nobody can rewrite the beneficiary. The beneficiary rotates per batch so that
  users are not clustered by one address.
- The fallbacks are any EOA calling `handleOps` directly (session ops) and the public Pimlico bundler, verified on all
  three chains, or any ERC-7562 bundler (owner ops). Nothing a user needs depends on Mamoru's bundler being up.

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

### D4. The owner is the user's passkey; the exit never depends on Mamoru's services

- **Owner model.** The owner is the user's passkey: a single signer (`SafeWebAuthnSharedSigner`, verified through the
  P-256 precompile on all three chains). One owner authorization grants Mamoru's session the bounded operational
  permissions of V-next. No second owner is required, and onboarding does not force one: the FR-ONB-004 change that
  would make a backup owner mandatory is not made. An **optional** backup owner (any wallet the user controls, proven
  by a signed challenge, added with one passkey-signed `addOwnerWithThreshold(…, 1)`) is offered in settings.
- **RP ID dependency, stated honestly.** The passkey's RP ID is `mamoru.lol` (`rpId = location.hostname`,
  `apps/mamoru-app/src/web/lib/passkey-sign.ts:72`). A browser produces an assertion only for an origin under that RP
  ID, so the owner's ability to sign depends on someone controlling `mamoru.lol` DNS. The Safe accepts the signature
  on chain from any origin, so what is at stake is producing it, not verifying it. Mitigations (D4-R1..R4):
  - **D4-R1: Domain held long-term.** `mamoru.lol` is prepaid for the longest term the registrar allows, with registrar
    lock and DNS at more than one provider.
  - **D4-R2: Static signer.** An open-source static signer page (build, sign and export a SafeTx or owner userOp; no
    backend) is published with a reproducible build. Anyone the domain owner delegates DNS to can serve it under the
    same RP ID from several hosts. Every such host must be `mamoru.lol` or one of its subdomains: Cloudflare, a
    subdomain DNSLinked to IPFS, a plain static host behind a subdomain. WebAuthn refuses `rpId: "mamoru.lol"` from
    any other origin. An ENS gateway such as `*.eth.limo` or a public IPFS gateway origin is therefore a mirror for
    verifying the build only, never a signing host, unless D4-R3 is used. Every signing host depends on `mamoru.lol`
    DNS. Mamoru's Worker going down does not remove the owner's signing path.
    - **RP ID pinned.** Today `rpId = location.hostname`, so a page at `exit.mamoru.lol` would ask for that
      subdomain's RP ID and an existing `mamoru.lol` passkey would not sign. The signer and the app therefore pass
      `rpId: "mamoru.lol"` explicitly, which WebAuthn allows from any subdomain. Beta keeps its own hostname-scoped
      credentials (AGENTS.md: do not change the beta RP ID). T2 tests an existing production credential from every
      host.
  - **D4-R3: Related Origins.** WebAuthn Related Origin Requests (`/.well-known/webauthn` on `mamoru.lol` listing
    other origins) are documented as an option for signing from another domain. They need `mamoru.lol` to serve that
    file, so they spread hosting but do not remove the domain dependency.
  - **D4-R4: Residual, disclosed.** If control of `mamoru.lol` is lost for good and the user never added the optional
    backup owner, the passkey can no longer produce signatures. The funds stay in the user's Safe: no one else can move
    them, but the user cannot either. The app says this where the optional backup owner is offered, and `/ops` counts
    the live accounts without one.
  - **D4-R5: Malicious signing page.** An attacker who takes over `mamoru.lol`, a subdomain or a signer host can serve
    a page that asks a returning user to tap for an attacker-built SafeTx. That one tap authorizes a transfer of the
    whole Safe. The Safe WebAuthn verifier checks the signature, not the page origin, and this risk exists today. The
    exposure is the balance of every user who signs on the compromised page while it is up. Mitigations:
    - registrar lock, DNSSEC and CAA records (D4-R1);
    - the static signer's release hash published in the repo, so a user or a third party can compare what a host
      serves;
    - nothing else. A decoded transaction shown by the page does not help, because a compromised page shows whatever
      it wants while asking for a signature over another hash. The passkey prompt shows only the RP ID. The optional
      backup owner does not help either: the passkey alone meets the threshold. The release hash helps only after
      the fact.

    Disclosed with D4-R4. A WebAuthn signer that pins the origin on chain would remove this risk. It is a new module,
    out of scope here.
- **Owner actions without the operator.** Today every withdraw, Stop and renewal is prepared, checked and sent by the
  operator (`operator.ts:4500-4640`). The app and the static signer build and sign SafeTxs and owner userOps
  client-side from open-source code. The user sends them in one of three ways:
  - as an owner userOp through any ERC-7562 bundler, paid by the Safe;
  - by any submitter with a SafeTx refund (`gasPrice`, `refundReceiver = 0`, so the Safe repays `tx.origin`);
  - from the optional backup owner's wallet as `execTransaction`, paying its own gas.

  The walkaway docs state the native amount each path needs per chain. An exit always needs upfront gas from the Safe
  (userOp prefund) or from some wallet, and no design removes that. The operator may offer to relay. Its refusal never
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
  shown to the owner as the maximum loss. Per-period limits and `total` are sized for a year of operation.
- **POL-04: 365-day sessions, renewed ahead, wound down safely.** TimeFramePolicy `validUntil` stays 365 days
  (`packages/policy/src/policies.ts:51`, `policies-v4.ts:53`). The product promise is set-and-forget: a strategy never
  stops because the user did not open the app. Security comes from the per-period limits, the lifetime `total` and gas
  ceiling sized for that year (POL-02/03/11), and the closed call surface (POL-05..07), not from a short expiry.
  - **Renewal prompt.** About 30 days before expiry the app and a notification ask for one passkey tap to renew
    (POL-03: a new generation with its own `total`).
  - **Wind-down if missed.** In the last 7 days before expiry with no renewal, the agent opens no new risk: no new
    position, no entry swap, no bridge-out. Existing positions stay as they are and remain closable by the owner
    through the walkaway path. At expiry the session can no longer act. Funds are never locked: the owner path does not
    depend on the session.
- **POL-05: Configuration calls refused.** The action policy refuses every call whose target is the account itself, the
  Safe7579 adapter, SmartSession or the registry. That covers `installModule`, `uninstallModule`, `setRegistry`,
  `execTransaction`, owner and threshold changes, `setFallbackHandler`, `setGuard` and `enableModule`. SmartSession
  does not block these on its own (round 3, Q4).
- **POL-06: ERC-1271 off.** `erc1271Policies` and `allowedERC7739Content` stay empty. A test proves a session-key
  `isValidSignature` returns failure.
- **POL-07: Reviewed tokens and venues only.**
  - **Approvals:** exact amount, only to pinned spenders, and only in a batch shaped as follows:
    1. `approve(spender, x)`;
    2. the consuming call;
    3. `approve(spender, 0)`;
    4. a call to an immutable, stateless, fund-less `AllowanceCheck.assertZero(token, account, spender)` that reverts
       the batch if the allowance is not 0.

    Safe's MultiSend checks call success, not a returned `false`, which is why the reset alone is not enough. The
    policy refuses a batch without steps 3 and 4. Admitted tokens must also revert or return `true` on `approve`. T5
    tests this per admitted token and per executor path.
  - **Recipients:** pinned to the account.
  - **Nested calls:** routers, multicalls and bridges have their nested recipient, token and amount decoded and
    bounded, as V3 already does for CCTP (`depositForBurn`: recipient = account, pinned domain and token, fee 0).
    `destinationCaller = 0` is pinned explicitly so that anyone can complete the mint.
  - **Tokens:** fee-on-transfer, rebasing and callback tokens stay out.
  - **Upgradeable venues:** a venue or spender behind an upgradeable proxy is admitted only with a per-venue position
    cap inside the account's `total`, so a hostile upgrade loses at most that cap. An issuer whose own token is
    upgradeable (USDC, the CCTP messenger) is an issuer risk (WLK-06), not a venue.
- **POL-08: Accounting under failure.** Budget spent at validation by an op that reverts later is strictly bounded by
  the same per-period and total limits. It never blocks owner exit.
- **POL-09: Same address on every chain with a session grant.** That is Base and Monad today. Ethereum carries no
  session grant (its bridge-out is an owner/paymaster userOp), and gets V-next only when a grant there is added.
  CREATE2 with a pinned compiler and `bytecode_hash = none`. Per-chain constants live in a `chainid` table in code, and
  an unknown chain refuses.
- **POL-11: Gas ceiling per generation.** `MamoruGasPolicy` per-op caps (`maxFeePerGas` × (verificationGasLimit +
  callGasLimit + preVerificationGas + paymaster gas limits), every one of them capped; `permitERC4337Paymaster` stays
  false so paymaster fields are 0) times
  the UsageLimitPolicy op count is the most a generation can spend on gas, including ops that revert. Today's counts
  (`manageAny 32,000`, `policies-v6.ts:11`) make that figure meaningless. The count is sized so the figure fits a
  stated gas ceiling, which is added to the maximum loss shown to the owner. A leaked key can burn at most that ceiling
  and never more than the Safe's native balance.
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
- **GRD-03: Per-account migration with a cutoff.** Each account moves to V-next with an owner-signed renewal; the
  generation jump already exists. The renewal batch also calls `removeSession` for the V2 session, so the removal is
  provable on chain. The app asks every V2 account to renew now rather than at expiry. From a published cutoff date
  the operator stops signing V2 grants and deletes its V2 session keys. Neither deletion can be proven on chain.
  **Accounts that ignore renewal:** until V2's own `validUntil`, two things remain possible:
  - a copied V2 session key can still act within V2's on-chain bounds: caps, pinned recipients, and its TWAP-band
    and budget checks. Pinned recipients do not prevent value loss through bad trades inside those bounds, so the
    disclosed worst case for such an account has two parts:
    - **Trade loss:** up to V2's remaining `total` for the generation. The per-period bucket refills, but `total` does
      not.
    - **Gas debits:** a copied key can act as its own bundler and beneficiary, and the Safe pays every op's
      `actualGasCost`, reverting ops included. Because the key also picks the fee and keeps the difference, the bound
      holds only where the grant caps both of these:
      - the per-op maximum prefund: (`verificationGasLimit` + `callGasLimit` + `paymasterVerificationGasLimit` +
        `paymasterPostOpGasLimit` + `preVerificationGas`) × `maxFeePerGas`. Each of the five gas fields and
        `maxFeePerGas` is capped by `MamoruGasPolicy`. T9 confirms the policy reads all six, pins the EntryPoint
        version, and confirms that public bundlers accept the passkey owner path under ERC-7562;
      - the op count (`UsageLimitPolicy`), confirmed by T9 not to refill within the grant. If it refills, the count
        becomes count × periods until `validUntil`.

      The bound is then count × maximum prefund. Otherwise the bound is everything the key can reach until V2's
      `validUntil`: the Safe's native balance at any time, including later top-ups, plus its EntryPoint deposit, plus
      any admitted paymaster allowance.

    T9 states both parts per account, citing V2's bounds and the grant's gas policies by file:line;
  - the guardian, if a copy of its key exists, can still pause that account's sessions. It cannot touch the owner
    path or move funds.

  The owner can end both at any time with `removeSession` from the walkaway path. Those accounts stay flagged under
  GRD-04 until V2 expiry or removal. A ledger lists every account and the policy it runs.
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
- **KEY-05: Published exposure.**
  - **Per account and in aggregate.** The signing service publishes each account's maximum exposure (remaining
    `total` + gas ceiling) and the sum across the accounts it serves. It shows the per-account figure to its owner and
    the aggregate on `/ops`, with an alert when the aggregate grows past a stated figure.
  - **Isolation.** Per-account keys sit under separate key policies, so one IAM grant cannot reach all of them.
  - **Attested signer.** The signer runs in an attested TEE that re-checks the V-next rules before signing, as defence
    in depth. It is not a substitute for the on-chain bound.
- **KEY-06: No shared global on-chain limit.** A contract-wide budget that every account's session debits is rejected.
  It would couple users: one actor (a compromised account, or one with a large legitimate flow) could exhaust the
  shared capacity and block every other user's automation. That is a censorship vector, which C4 forbids. Exposure is
  bounded per account and published in aggregate instead.

### Registry and attesters (REG)

- **REG-01: Self-attest every module a grant uses.** That includes SmartSession and UniActionPolicy, which today only
  Rhinestone attests (`packages/account/sessions/index.ts:364-391`).
  - **Requires trusting itself.** Self-attestation works only if the account trusts itself as an attester. Activation
    already sets `trustAttesters(1, [RhinestoneAttester, account])` (`sessions/index.ts:374-379`). T9 checks every
    live account's attester set and threshold, and an account missing itself gets an owner `trustAttesters` call.
  - **Effect.** Once that holds, a revocation by Rhinestone cannot block new sessions or renewals.
  - **Already true regardless.** A registry change never stops an enabled session or an owner action, because the
    registry is checked at enable and install only.
- **REG-02: Deployment availability.** The deploy path (Safe7579 launchpad) also checks the registry at module install
  (`V3SetupFork.t.sol:1163`). If Rhinestone revokes a module, new Safe deployments that install it fail. That is an
  availability risk for new users, not a custody or exit risk. T3 records which modules the launchpad installs and
  which attestation they rely on.

### Walkaway exit (WLK)

- **WLK-01: Full coverage.** `walkawayCalls` (`packages/account/owner/index.ts:40`) and `docs/walkaway.md` cover every
  chain, asset and position a policy can create. Today they cover Base with USDC and cbBTC only. Missing: USDT, WETH,
  EURC/JPYT, ERC-4626 vault shares, the Monad sleeve (Safe on chain 143, WMON/USDC LP), CCTP burns in flight (the
  permissionless `receiveMessage` step) and ETH left on L1. The exit also enumerates every non-zero allowance the Safe
  has granted and revokes it (`approve(spender, 0)`) in the same transaction.
- **WLK-02: Static frontend.** An open-source static frontend on IPFS with an ENS name builds and signs the exit with
  the user's passkey on a host under `mamoru.lol` (D4-R2; an ENS/IPFS gateway origin only verifies, it cannot sign),
  or with the optional backup owner anywhere. It needs no
  Mamoru backend.
- **WLK-03: Tested with Mamoru off.** In CI, on a fork of each chain, Mamoru's operator, relayer, bundler and Worker
  are unreachable. Two cases:
  - **(i) Passkey, domain available.** The passkey owner signs on the static signer served from a non-Mamoru host
    under `mamoru.lol` (D4-R2).
  - **(ii) Backup owner, domain unavailable.** An account with the optional backup owner signs from that wallet.

  In both cases the user revokes every session and allowance and withdraws every asset through a public RPC and a
  public bundler, or a plain `execTransaction`. A passkey-only account with the domain gone is the disclosed D4-R4
  residual; it is not tested as passing.
- **WLK-04: Agent of the user's choice.** The owner can always grant a V-next session to a key they choose. That is
  an owner power no Mamoru component can veto, and the static frontend exposes it. An optional self-hosted agent mode
  (open-source agent run with the user's own session key) comes later. Until it ships, the guarantee is the owner's
  power to grant a key, not continuity of the strategy: if Mamoru stops running the agent, the strategy stops while
  funds stay withdrawable. Once the agent ships, Mamoru refusing service stops only Mamoru's offer.
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
| Session key leaked | Acts within the grant for 365 days | Per-period + total limits and gas ceiling sized for the 365-day session, closed call surface, per-account key in KMS/TEE | Up to the remaining `total` of one generation |
| Session escapes policy (self-call, module install, ERC-1271, nested router call) | Self-calls not blocked by SmartSession; ERC-1271 empty | POL-05/06/07 with tests | Bugs in V-next (audit, fuzzing) |
| Relayer key leaked | Float on three chains, one key | Dust per chain, KMS, no authority | One bundle's float |
| Mamoru refuses or disappears | No owner signature off-domain; owner actions go through the operator | Static signer under the same RP ID from several hosts, domain held long-term, client-built owner txs (Safe-paid userOp or SafeTx refund), optional backup owner, user-chosen agent, CI test with Mamoru off | Loss of `mamoru.lol` for good, for accounts without the optional backup owner: funds stuck, not stolen (D4-R4) |
| Hosted signer service compromised | Every served account's session key | Per-account key policies, attested TEE, per-account and aggregate exposure published (KEY-05); no shared global limit (KEY-06) | Sum of remaining totals + gas ceilings of served accounts |
| Session burns gas | 32,000 ops × per-op cap | Gas ceiling per generation (POL-11) | That ceiling |
| Rhinestone revokes an attestation | Blocks new enables and renewals of Rhinestone-only modules | Every module self-attested | New Safe deploys through the launchpad (availability) |
| Bug in an infra contract with no admin | n/a (no funded infra) | None funded in v1; conditional `GasTreasury` bounded by lifetime ceiling | Its ceiling |
| Wrong constructor parameters | n/a | Fork test of exact init calldata; bytecode and code-hash check per chain; unknown chain pays nothing | A wrong value stays until the next version |
| Shared V4 executor bug | Undeployed design reaches every account | Not deployed (POL-10) | None |
| Users linked by one beneficiary / shared keys | One relayer address on every bundle | Per-account session keys, rotating beneficiary | On-chain analysis of funding sources |
| Takeover of `mamoru.lol` or a signer host | Phishing page can obtain a full-Safe passkey signature | Registrar lock, DNSSEC, CAA; published signer hash (after the fact only) (D4-R5) | Balances of users who sign on the compromised page while it is up |
| Sequencer censorship, issuer freeze | Same | Documented (WLK-06) | Outside Mamoru's contracts |

## Out of scope

- An ownerless paymaster (D3: deferred until it can meet INV-4/5 without an oracle or a swap it can be gamed through).
- A loss-latch hook (D1).
- Cross-chain refuel services.
- Changing the passkey RP ID: it stays `mamoru.lol` (D4).
- A mandatory backup owner or a multi-owner threshold (D4: single passkey owner, optional backup).
- A shared global on-chain exposure limit (KEY-06).

## Tasks

**P0, no redeploy**
- **T1: Retire the guardian.** Do GRD-01/02: destroy the key, publish the retirement, remove the copy.
- **T2: Owner path.**
  - D4-R1: prepay the domain, registrar lock, multi-provider DNS.
  - D4-R2: the static signer, reproducible and served from at least two hosts under `mamoru.lol`. `rpId` is pinned to
    `mamoru.lol` in the signer and the app. First, check from the stored credentials that every production passkey
    was registered with RP ID `mamoru.lol` and not a subdomain; then test an existing production credential from
    every host. **If any credential is scoped to a subdomain**, that account can sign only under that host, so for it
    D4-R2's several hosts do not exist. The account is flagged on `/ops` and the app asks the owner to add a new
    `mamoru.lol`-scoped passkey as owner, signed with the old one, then to remove the old passkey. Exception to the pin:
    on each such legacy host, a signer that requests the credential's original `rpId` stays served until every flagged
    account on that host has migrated or exited. Until then, the account's walkaway is disclosed as single-host. A
    legacy host kept alive can also request `mamoru.lol`-scoped assertions, so its takeover is part of the D4-R5
    exposure for every account, not only the flagged ones. It is disclosed there and retired as soon as its last
    flagged account is done. T2
    also confirms from the Safe WebAuthn verifier's source whether it checks the `rpIdHash` in `authenticatorData`. If
    it pins a value, the new passkey's signer configuration must match it.
  - D4-R5: DNSSEC, CAA and the published release hash.
  - The optional backup owner in settings (FR-ONB-004 signed challenge), with the D4-R4 disclosure and the `/ops`
    count.
- **T3: Inventory checks.**
  - Make the self-reserve swap mandatory and delete the ETH top-up (G3).
  - Inventory every Mamoru-deployed contract on every chain with an entry-point analysis (INV-4).
  - Script the bytecode and registry checks: no pause selector in V-next, the launchpad module and attestation
    inventory for REG-02, and the pinned code hashes.

**P1, one redeploy**
- **T4: V-next.** Implement POL-01..11 from V3, with no pause code, limits on the vault and bridge families, and the
  gas ceiling. Deploy with CREATE2 to the same address on every chain with a session grant (Base and Monad today), and
  pin it in the registry.
- **T5: Fork tests for the session surface.**
  - Self-calls (each selector in POL-05) are refused.
  - ERC-1271 by a session fails.
  - Delegatecall and executor modes are refused.
  - Nested router recipients are bounded.
  - No allowance survives a batch.
  - `destinationCaller` is 0.
  - Owner ops are admitted by a standards-compliant ERC-7562 bundler.
- **T6: Invariant fuzzing.** The per-period and total limits hold under batching, nonce races, reverting ops and
  re-enable. POL-03: no path raises a generation's `total`.
- **T7: Renewal.** The renewal flow moves accounts off V2 and `MamoruPauseGate` (GRD-03) keeps the 365-day expiry,
  and adds the renewal prompt and the wind-down (POL-04).
- **T8: Self-attestation.** Self-attest SmartSession and UniActionPolicy (REG-01).
- **T9: Per-account state check.** For every live Safe: owners, threshold, guard, fallback handler, modules, executors,
  trusted attesters and policy version (INV-3, REG-01), plus the GRD-03 cutoff and the GRD-04 flag on `/ops`.

**P2, user-paid execution**
- **T10: Account-paid sends.**
  - Turn G1, G2 and G4 into account-paid userOps, with the first-operation options (a) and (b).
  - Turn G5 and G6 into destination-Safe userOp mints.
  - Delete G7.
  - Add the INV-6 payer trace in CI and on `/ops`:
    - per-userOp attribution from `UserOperationEvent`;
    - one userOp per bundle, the beneficiary checked against the declared Mamoru beneficiaries, and the submitter's
      total fee (including the L1 data fee on Base) against that op's `actualGasCost`, within the per-chain tolerance
      in wei;
    - the admission rule (simulation, `preVerificationGas` margin over the estimated L1 fee);
    - reverted bundles counted per account with the daily cap and against the per-chain global daily budget (a hard
      stop for Mamoru's bundler once spent, self-caused reverts included); the
      private submission is cancelled or replaced before any public fallback, and the declared beneficiary set is
      updated before a rotated beneficiary is first used;
    - a provenance ledger of every outgoing transfer from Mamoru wallets.
- **T11: Bundler.** Relayer keys per chain in KMS, private submission with a public-bundler fallback, rotating
  beneficiary. Build `GasTreasury` (TRS-01..07, with Halmos and fuzzing for INV-5) only if D3's condition holds.

**P3, keys and exit**
- **T12: Session keys.** Session keys in KMS/TEE, per account, with KEY-05 (isolation, published aggregate exposure,
  attested signer). Delete the plaintext state copies and the standby VPS key bundles.
- **T13: Walkaway.** Do WLK-01..03 and WLK-05: full coverage, IPFS/ENS frontend, CI on forks of all three chains with
  Mamoru off.
- **T14: Agent of the user's choice.** WLK-04: owner-granted session to a user-chosen key from the static frontend;
  the optional self-hosted agent mode later.

## Scenarios

- **S1: Leaked session key.** A leaked session key drains as fast as it can. Loss is at most the remaining `total` of
  the generation, never more after expiry, and only to pinned destinations.
- **S2: Mamoru disappears.** Domain, Worker, operator and bundler are all gone. The user opens the IPFS frontend, signs
  with their passkey (static signer under `mamoru.lol`, D4-R2) or the optional backup owner, revokes every session and
  allowance, and withdraws every asset on Base, Monad and Ethereum.
  They send it as `execTransaction` from their own wallet or through a public bundler. The burns still in flight are
  minted by the user.
- **S3: Leaked guardian key.** Someone holds the retired guardian key. No V-next account can be paused. V2 accounts are
  listed as non-compliant until renewed.
- **S4: Policy surface.** A session tries `installModule`, `setRegistry`, `execTransaction`, ERC-1271 and a router call
  with a foreign recipient. All are refused.
- **S5: Rhinestone revokes.** Existing sessions and owner actions continue. New sessions continue for self-attested
  modules.
- **S6: Relayer key leaked.** Loss is one bundle's float on one chain. No user is affected.
- **S7: No relayer-paid user sends.** CI finds a relayer send for a user action outside `handleOps`, and the build fails.
- **S8: Missed renewal.** The user ignores the renewal prompt. In the last 7 days the agent opens no new risk; at expiry
  the session stops. Positions and funds stay in the Safe, closable by the owner at any time.
