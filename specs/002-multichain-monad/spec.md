# 002: Multichain execution, with moving funds between chains as a core capability

Ticket: otto/mamoru#59. Status: spec v2, 2026-10-29. Supersedes the draft of 2026-10-02 (branch
`spec/002-multichain-monad`, never merged), whose premise "one sleeve per chain, no automatic movement between chains,
CCTP out of scope" Ot revoked on 2026-10-27.

- Law: `inputs/mamoru-spec-v1.md` plus Ot's decisions of 2026-10-01 (Monad is an execution chain), 2026-10-18 (open
  venues and routes, noema `1-projects/mamoru/decisions/2026-10-18-venues-y-rutas-abiertas.md`) and 2026-10-27
  (moving funds between chains is core and its cost is always optimized,
  `1-projects/mamoru/decisions/2026-10-27-mover-fondos-entre-cadenas.md`).
- Constitution: `.specify/memory/constitution.md` v2.0.0 (principles III and XIX).
- Delta over `specs/001-mamoru-v1/`, which is not reopened. Umbrella ticket: otto/mamoru#201.

## What this pack covers

Mamoru runs on more than one chain and moves the account's own funds between them as part of normal operation.

- **Base (8453)** is the primary execution chain. The account is born there and deposits arrive there.
- **Monad (143)** is an execution chain. Policy v6 puts the Growth bucket (15 %) there, in WMON/USDC.
- **Ethereum (1)** is an entry chain. Funds found at the account's address there are converted to USDC if needed and
  routed to Base. No strategy runs on Ethereum unless the Lab shows it wins after gas (otto/mamoru#244).

Moving funds between chains is a capability with its own requirements: pick the cheapest safe route and show it,
wait and batch when the route is expensive, count money in flight once, recover a stuck move, check that the
destination can work before money leaves, withdraw across chains, and ask the owner for as few signatures as
possible. Every move is measured (route, bridge fee, gas on both chains, slippage, time in flight), the cost per move
is a tracked number, and a new or cheaper route enters through the Lab before it moves live funds.

Much of this is already built on `main`. Each requirement below says **Built** (with the commit), **Partial** (what
exists and what is open, with the ticket) or **Open** (the ticket). Tasks (`tasks.md`) exist only for open work.

## System as built (2026-10-29, `origin/main` at `8c42847c`)

| Area | What exists | Where | Commits, tickets |
|---|---|---|---|
| Chains | `ChainId = 8453 \| 143`, `ChainDescriptor` (block time, finality tag, gas model, L1 data fee, per-tx gas cap, explorer, testnets), `SUPPORTED_CHAINS`, `chainOf`, `FORBIDDEN_LAB_CHAIN_IDS` derived from the list | `packages/domain/src/chains.ts` | #61 |
| Registries | `base.json` (block 51811000), `monad.json` (block 109737151), `registryFor`, `assertRegistryChain`. `entry`, `address`, `nameOf` still default to `baseRegistry` (deprecated overload) | `packages/registry` | #60 open |
| Writes per chain | Base always; Monad only with `MAMORU_LIVE=1` and `MAMORU_CHAIN_WRITES=143`. A non opted-in operator signs nothing off Base. The write registry checks Base's account stack and code hashes on the other chain | `chains.ts`, `apps/mamoru-operator/src/chain-writes.ts` | `62377b05`, `fa370b79` (#61, #63) |
| Gas on Monad | Loopback bundler estimates plus 10 % on `gas_limit` chains, never a fixed limit; relayer keeps the 10 MON protocol reserve | `apps/mamoru-operator/src/bundler.ts` | `62377b05`, `ad915310`, `81778e94` |
| Session policies on Monad | TimeFramePolicy and UsageLimitPolicy deployed at their Base addresses (CREATE2) by `monad:deploy-policies`; the operator requires Base's code hash; MamoruGasPolicy and MamoruActionPolicyV2 pinned on Monad | `scripts/monad/`, `packages/scenarios/monad/`, `monad.json` | `c0db1c37`, `d7689c69`, `579b3f95` (#62 open) |
| Lab | Monad fork harness and MONAD-01 (enter, harvest, exit WMON/USDC); fork chain ids 31337 (Base, Ethereum) and 314143 (Monad); `assertLabChainId`, `gateScenario` | `packages/scenarios/monad/`, `scenarios/monad/manifest.json` | `f41bc05b` (#65) |
| D1 per chain | `account_activity.chain_id`, one sleeve row per user and chain (`accounts_user_sleeve`), chain index on the projection | `migrations/d1/0017_chain_keyed_sleeves.sql` | `cabd3077` (#64 partial, #67) |
| Engine Worker | Cron sync, still Base-only: `CHAIN_ID 8453`, `deps.registry ?? baseRegistry` | `apps/mamoru-engine/src/sync/run.ts` | #64 open |
| Policy v6 | `conservador-live-v6`: 50 Stable (USDC/USDT, Base), 35 Balance (WETH/USDC, Base), 15 Growth on Monad (WMON/USDC through `live-wmon-usdc-monad-v5`); bridge-out grant: USDC approve to TokenMessengerV2 and `depositForBurn` with domain 15, `mintRecipient` = account, `burnToken` = USDC, `destinationCaller` 0, `maxFee` 0, finality ≥ 2000 (Standard), per-call and total caps; MamoruPauseGate | `packages/policy/src/policies-v6.ts`, `grants.ts` | `0a9000c4`, `4b35f156`, `d003e250`, `537caa34` (#213) |
| Offering v6 | Behind ops flag `multichain_v6` with a per-account allowlist; the operator refuses v6 as default; renewal to v6 needs an active Monad sleeve (`SLEEVE_NOT_ACTIVE`) | operator, `apps/mamoru-app/src/api/ops-flags.ts` | `594d4ce7`, `ac5e6eb4`, `fe385a78` (#217) |
| Monad sleeve | `POST /api/sleeves {chainId: 143}` adds a row with the same Safe address after `safeDerivationDiff` (`CHAIN_ADDRESS_UNVERIFIED`); activation is an owner transaction on Monad; beta host and `monad_sleeves` flag only | `apps/mamoru-app/src/api/sleeves.ts` | `84bb2cd3`, `0d422180` (#214), #240 open |
| Allocator | Remote bucket gap across both chains; `DECIDE_BRIDGE_OUT` or `DECIDE_WAIT_BRIDGE` (sleeve not ready, bridge in flight, no bridge session); falls back to the local entry; one-way Base → Monad | `packages/decide/src/allocate/index.ts` | `e46d8b8f`, `fed514d4` (#215) |
| Bridge leg | Journal per burn (`sending`, `burned`, `minted`, `failed`, `dropped`) written before signing; Circle attestation checked against the burn and the attesters on Monad; the operator relayer calls `receiveMessage` on Monad under gas, price and daily caps; in-flight counted in the remote value; failure cooldown | `apps/mamoru-operator/src/bridge-monad.ts`, `cctp.ts` | `6c2e959d`, `587c26bf`, `13a39432` (#215, PRs 143 and 144) |
| Consent | Existing accounts see the mix before and after; two passkey signatures: activate Monad, then renew Base to v6 | `apps/mamoru-app/src/web/components/monad-consent.tsx` | `19b74282`, `09f3866c`, `d81b11c3` (#216) |
| Dashboard | One balance over both chains; each position names its chain; actual vs target per bucket; bridge progress on the move | app | `51482f5e`, `9a8b6f9b` (#201, #216) |
| Account cap | Total across chains, idle plus placed | operator | `120a390c` (#135, #212) |
| Routing library | Normalised quotes (provider, route, out, fee, ETA, target, calldata, `recipientCheck`, signing mode); adapters CCTP V2, Across, Relay, LI.FI, deBridge, canonical; ranking by net output | `packages/routing` | #181 |
| Ethereum entry | Read-only notice of USDC on Ethereum; owner-signed move to Base (Across or CCTP V2, ranked by output); ETH converted to USDC first by a separate owner signature; one ERC-4337 userOp with an ERC-20 paymaster (built, not active: needs a paymaster key) | `apps/mamoru-app/src/api/accounts/other-chains.ts`, `apps/mamoru-operator/src/bridge-out.ts`, `paymaster.ts` | `c189fbc5` (#133), #211, `c1073300` (#180 open) |
| Yield ledger | Daily gas per account and chain from `UserOperationEvent.actualGasCost`; nothing bridge-specific | `migrations/d1/0010`, `0015`, `yield-receipts.ts` | #129 |

## Facts this pack uses

On-chain reads against Monad mainnet, 2026-10-01/02 (noema
`1-projects/mamoru/research/monad/monad-multichain-plan-2026-10-01.md`), plus what the built code pins.

- The account stack is at the same addresses on Monad with identical bytecode: EntryPoint v0.7, SafeL2 1.4.1,
  SafeProxyFactory, Safe7579, Safe7579Launchpad, RhinestoneAttester, SmartSession, OwnableValidator, UniActionPolicy,
  SafeWebAuthnSharedSigner, P256Verifier, MultiSend, MultiSendCallOnly, Multicall3. ModuleRegistry has other bytes
  and its own pinned hash.
- TimeFramePolicy and UsageLimitPolicy were missing and were deployed later at the Base addresses (#62).
- RIP-7212 (P-256 at `0x0100`) works. Monad charges gas on the gas limit, not gas used. Uniswap v3 is at other
  addresses than on Base. An Alchemy bundler supports Monad with EntryPoint v0.7.
- CCTP V2: TokenMessengerV2 `0x28b5…cf5d` and MessageTransmitterV2 `0x81D4…4B64` at the same addresses on Ethereum,
  Base and Monad; domains Ethereum 0, Base 6, Monad 15 (`localDomain()` read 2026-10-27). Standard finality from Base
  takes about 15 to 20 minutes and has no fee; Fast has a variable fee (`GET /v2/burn/USDC/fees/{src}/{dst}`).
- Across: `depositV3` pins `depositor` and `recipient`; a deposit nobody fills is refunded only after `fillDeadline`,
  in hours. Relay's recipient lives off-chain. Measured 18 Oct, 150 USDC Ethereum → Base: Across 0.019 USDC, Relay
  0.036 USDC, LI.FI about 0.25 % (ticket #133).

## Actors

Those of 001. The user has one account and one balance; the chain is a detail of each position (#201). The operator
runs one process per chain. The guardian can pause bridge-out (MamoruPauseGate). The attacker gains vectors: replay on
the other chain (same address), a compromised route provider or attestation service, spoofed messages, forced or
repeated bridges to drain gas, and money stranded between chains.

## User stories

### US10 · One deposit, two chains (P1)

The user deposits USDC on Base. Mamoru splits it by bucket, and the bucket picks the chain: 15 % goes to Monad without
the user choosing a chain.

- Given a v6 account with a ready Monad sleeve and a Growth gap above the entry minimum, when the engine reviews, then
  `DECIDE_BRIDGE_OUT` proposes the gap, the move is journaled before it is signed, and the USDC arrives in the same
  account on Monad (FR-XCH-001, FR-XCH-002, FR-XCH-008).
- Given money in flight, when the engine reviews again, then `DECIDE_WAIT_BRIDGE` and the money counts once in Growth
  (FR-XCH-008).
- Given a harvest on Monad, then its USDC stays on Monad (FR-XCH-013).

### US11 · The cheapest safe route, shown (P1)

- Given several providers can move the amount, when Mamoru picks a route, then it ranks by net output after every cost
  it can price, drops any quote whose recipient it cannot prove is the account, and only a route a session policy can
  pin runs without the owner (FR-XCH-003, FR-XCH-004, FR-XCH-005).
- Given the user opens the move, then they see the route, what it cost and how long it took or should take
  (FR-XCH-017, FR-COST-004).

### US12 · Wait when the route is expensive (P1)

- Given the route's total cost is above the ceiling, then the move waits and is quoted again; small moves of the same
  account go out as one; after the maximum wait the money stays on Base with a reason, never silently (FR-XCH-006).
- Given the waiting state, then the app says Mamoru waits for a better moment to enter Growth, with no amounts; the
  cost breakdown is in the details (FR-XCH-017).

### US13 · The destination must be able to work (P1)

- Given the owner revoked the Monad sessions but SmartSession stays installed, when the engine considers a bridge,
  then `DECIDE_WAIT_BRIDGE` with the session reason and nothing leaves Base (FR-XCH-007).

### US14 · A move that does not arrive (P1)

- Given a burn that is not attested or minted within its deadline, then ops get an alert, the app names the reason on
  the move, and the owner can finish the mint without Mamoru (FR-XCH-010).
- Given a burn whose userOp reverted or was dropped, then nothing left the account, the sleeve cools down and the
  money goes to the local entry (FR-XCH-011).

### US15 · Withdraw across chains (P1)

- Given a withdrawal of a value to a chain and token the user picks, then Mamoru takes it from Stable first, then
  unwinds positions across both chains by a fixed priority, shows the steps and what arrives before signing, and a
  countdown when a bridge or swap is needed (FR-XCH-012).

### US16 · Few signatures (P2)

- Given an existing account moving to v6, today it signs twice (Monad activation, then Base renewal). Target: one
  passkey signature covers both chains, if the deployed SmartSession and the Safe owner flow allow it (FR-ACC-017).

### US17 · Funds on Ethereum (P1)

- Given USDC at the account's address on Ethereum, then the app says so, and one owner signature moves it to the same
  account on Base, with gas paid in USDC when a paymaster is configured. Given ETH, the owner first converts it to USDC
  with its own signature, then moves the USDC (FR-XCH-015).

### US18 · Cost per move goes down over time (P1)

- Given moves happened, then the daily report shows the cost per move by route, and a release or Lab run that changes
  routing shows the number before and after; a new or cheaper route proves itself in the Lab first (FR-COST-005 to
  FR-COST-008).

### US19 · No piece assumes the chain (P1)

- Given a developer omits the registry, policy or chain, then they get a type error or `CHAIN_UNSUPPORTED`, never Base
  (FR-CHN-002).

## Requirements

Status words: **Built** (on `main`, with commits), **Partial** (part on `main`, the rest open), **Open**. The ticket
named is where the open part lives. Ids FR-CHN-001 to FR-CHN-003 keep the meaning the code already cites.

### Chains (FR-CHN)

- **FR-CHN-001.** There MUST be a closed `ChainId` type and a `SUPPORTED_CHAINS` list of descriptors in
  `packages/domain`, each with block time, finality tag, gas model, L1 data fee, per-transaction gas cap, explorer
  host, testnet ids and a **role**: `execution` (Base, Monad) or `entry` (Ethereum). No other package keeps its own
  chain list. *Partial:* the list exists for Base and Monad (#61). Open (#60): Ethereum's descriptor, the role field,
  and retiring the parallel lists in `packages/routing/src/chains.ts` and the constants in
  `apps/mamoru-operator/src/bridge-out.ts`.
- **FR-CHN-002.** There MUST be no default chain. A function that needs a registry, policy or chain configuration
  takes it as a required argument; omitting it is a type error; a chain outside the list is `CHAIN_UNSUPPORTED`.
  *Partial:* `registryFor`, `assertRegistryChain`, `assertPolicyChain` exist. Open (#60): the `baseRegistry` default
  of `entry`, `address`, `nameOf`, of `apps/mamoru-engine/src/sync/run.ts` and of the loopback bundler.
- **FR-CHN-003.** `FORBIDDEN_LAB_CHAIN_IDS` MUST be derived from `SUPPORTED_CHAINS`: every supported id and every
  testnet id, entry chains included. A lab fork's chain id is never one of them. *Partial:* derived for 8453, 84532,
  143 and 10143. Open (#60): 1 and 11155111 once Ethereum has a descriptor.
- **FR-CHN-004.** Each chain MUST have one registry with its block, block hash and a code hash per entry, and no
  address enters it without an on-chain read at that block (code hash; `symbol()`/`decimals()` for tokens;
  `factory()` for Uniswap pieces). Contracts the capital path calls on a chain are in that chain's registry, bridge
  contracts included. *Partial:* `base.json`, `monad.json` (#60). Open (#60, #62): TimeFramePolicy and
  UsageLimitPolicy pinned in `monad.json` instead of added at boot; TokenMessengerV2 in `monad.json`;
  MessageTransmitterV2 in both; an Ethereum registry for the entry path.
- **FR-CHN-005.** Writes MUST be opt-in per chain: Base when live, any other execution chain only when listed in
  `MAMORU_CHAIN_WRITES`, and an operator that is not opted in signs nothing off Base. *Built:* `62377b05`, `fa370b79`.
- **FR-CHN-006.** There MUST be one operator process per chain, with its own state directory, relayer key and
  loopback bundler. *Built* (#61, #63).
- **FR-CHN-007.** The per-account cap MUST be the total across chains, idle plus placed. *Built:* `120a390c`.
- **FR-CHN-008.** A policy MUST name its chain and resolve its pools against that chain's registry; a fork policy
  signs only on a non-forbidden chain id. *Built:* `assertPolicyChain` (`packages/policy/src/instantiate.ts`).
- **FR-CHN-009.** The engine sync and the D1 projection MUST be keyed by chain: one sync per active chain with that
  chain's registry, policy and RPC; a chain without RPC is logged as `CONFIG_CHAIN_RPC_MISSING` and does not block the
  others; metrics split by chain; Base rows migrate without loss. *Partial:* D1 sleeve rows and activity carry
  `chain_id` (`0017`). Open (#64): the engine Worker is Base-only, metrics are not split.
- **FR-CHN-010.** MultiBaas MUST be accepted per chain by MB-01 (a real query on a known pool, reconciled with
  `eth_call`) or stay out of the engine for that chain. *Open* (#64).
- **FR-CHN-011.** An entry chain MUST hold no strategy: Mamoru detects funds there, converts them to USDC if needed and
  routes them to Base. Running positions on an entry chain needs a Lab result that wins after gas and a constitution
  amendment. *Built* as the entry path (FR-XCH-015). The Lab question is #244.

### Account and sessions per chain (FR-ACC)

- **FR-ACC-012.** Enabling sessions on a chain MUST require every policy the grant encodes (TimeFramePolicy,
  UsageLimitPolicy, UniActionPolicy, Mamoru's own policies) to have code on that chain with the pinned hash; otherwise
  `SESSION_POLICY_UNAVAILABLE_ON_CHAIN` and no call. *Built:* `chain-writes.ts` `writeRegistry`. Open (#62): the
  deployment evidence in the repo and a fork scenario where expiry and usage limit bite on Monad.
- **FR-ACC-013.** The attestation path MUST be checked per chain against that chain's ModuleRegistry
  (`SESSION_ATTESTATION_UNAVAILABLE_ON_CHAIN`). *Built:* `chain-writes.ts`.
- **FR-ACC-014.** The counterfactual address MUST be computed per chain and compared; equality is observed, never
  assumed (`CHAIN_ADDRESS_UNVERIFIED`). *Built:* `sleeves.ts` `safeDerivationDiff`.
- **FR-ACC-015.** A userOp or owner transaction signed for one chain MUST fail on the other because the chain id is in
  the userOp hash and in the Safe's EIP-712 domain, even with identical keys and grants on both. *Open:* the fork test
  (SESS-27) is part of #62.
- **FR-ACC-016.** Opening the Monad sleeve MUST work on production, keeping the Safe derivation check, before v6 is
  offered there. *Open* (#240). New accounts open both Safes in onboarding (#231).
- **FR-ACC-017.** Moving an account to a multichain policy SHOULD take one passkey signature for both chains (Smart
  Sessions multichain enable over chain digests, or a Safe ERC-7739 signature over a merkle root), verified against the
  SmartSession deployed on Base and Monad. Until then two signatures, in the order Monad then Base. *Partial:* two
  signatures built (#216). Open (#230). Upgradeable policies and Permit2 are out (#230).

### Gas (FR-AA)

- **FR-AA-006.** On a `gas_limit` chain, userOp and outer transaction limits MUST come from an estimate plus a stated
  margin, never a constant. *Built:* `bundler.ts` (`BUNDLE_GAS_MARGIN` 11/10), `MONAD_MINT_GAS_CAP` for mints.
- **FR-AA-007.** The account's refund (`actualGasCost`) and the relayer's spend MUST be recorded apart, per chain.
  *Partial:* account gas per day and chain in the yield ledger; relayer mint spend on Monad only as a daily budget
  counter. Open (#129, #97).

### Moving funds between chains (FR-XCH)

- **FR-XCH-001.** A policy MAY place a bucket on another execution chain (`remoteBuckets`); the allocator measures
  that bucket's gap over the combined value of both chains. Only one remote bucket. *Built:* `0a9000c4`, `e46d8b8f`.
- **FR-XCH-002.** A remote gap above the entry minimum and outside the rebalance band MUST become a `bridge_out`
  proposal (`DECIDE_BRIDGE_OUT`); while the destination is not ready, money is in flight, or no bridge session is live,
  `DECIDE_WAIT_BRIDGE` and the displaced amount goes to the local entry. *Built:* `e46d8b8f`, `fed514d4`.
- **FR-XCH-003.** Route choice MUST go through the routing layer: quote every provider that supports the direction,
  normalise, drop non-executable quotes, rank by net output after every priced cost (a quote with an unpriced cost
  never beats a priced one), tie on time. The chosen route, its quote and the runner-up are recorded with the move.
  *Partial:* the library (#181) and the Ethereum → Base move rank routes. Open (#133): the Base → Monad leg uses one
  fixed route (CCTP V2 Standard, no fee) without quoting.
- **FR-XCH-004.** A session key MUST only run routes whose recipient a session policy pins on-chain: CCTP V2
  `depositForBurn` (`mintRecipient` = the account, destination domain, `burnToken`, `destinationCaller`, `maxFee`
  bound, finality) and Across `depositV3` (`depositor` = `recipient` = the account, tokens, amount). Never
  `depositForBurnWithHook`, never an aggregator's calldata. Each grant has a per-call and a total cap and stops under
  the guardian's pause. *Partial:* CCTP grant built (`0a9000c4`, `4b35f156`, `d003e250`, `537caa34`). Open (#133 R3):
  the Across grant, so the engine can pick between two session routes.
- **FR-XCH-005.** Routes that cannot be pinned (Relay, LI.FI, other aggregators) MUST be owner-signed only: the app
  decodes the calldata and shows route, fee, time and the recipient = the same account on the destination chain; a
  quote whose recipient cannot be decoded and checked is not offered. *Built* in `packages/routing` (`recipientCheck`,
  `mode`) and the entry path.
- **FR-XCH-006.** Before a session-key move, the total cost (bridge fee + gas on both chains + spread) MUST be under a
  ceiling `min(absolute, bps of amount)` from engine settings. Over it: wait and quote again at a set interval, money
  keeps earning on Base; small moves of one account are batched; after the maximum wait the allocation stays on Base
  with `DECIDE_BRIDGE_SKIPPED`, logged per account. Defaults come from a week of measured Base → Monad quotes. *Open*
  (#188).
- **FR-XCH-007.** A move MUST leave only when the destination can work: the account's Safe has code there,
  SmartSession is installed, and the destination grants are enabled, not expired and have usage left. Otherwise
  `DECIDE_WAIT_BRIDGE` with the reason in `detail`. *Partial:* deployed and installed checks built
  (`bridge-monad.ts` `readSleeve`). Open (#243): the grants themselves.
- **FR-XCH-008.** Money in flight MUST count exactly once: the move is journaled before its userOp is signed; `sending`
  and `burned` count in the remote value; `minted` counts until the destination is read at or after the mint block; a
  journal that cannot be written blocks signing (`BRIDGE_JOURNAL_UNAVAILABLE`); one move in flight per account blocks
  the next. *Built:* `6c2e959d`, `587c26bf`, `13a39432`.
- **FR-XCH-009.** Completion on the destination MUST be proven from the chain: the attestation matches the journaled
  burn (message key, source and destination domains, sender and recipient the account, amount) and is signed by the
  attesters enabled on the destination; the relayer's mint runs under a gas cap, a price cap and a daily budget; a
  nonce already used marks the move minted with no transaction. *Built:* `bridge-monad.ts`, `cctp.ts`.
- **FR-XCH-010.** A move in flight MUST have a deadline per state, derived from the route's expected time and set in
  engine settings. Past it: an ops alert, the move marked stuck in the journal and the ledger, a reason on the move in
  the app, and an owner recovery path that works without Mamoru (CCTP V2 with `destinationCaller` 0 lets the owner
  call `receiveMessage` with Circle's attestation; an Across refund lands on the account after `fillDeadline`, shown
  as hours). *Open* (#245). Today a stuck burn retries forever and blocks later bridges of that account.
- **FR-XCH-011.** A move whose userOp reverted or was dropped MUST end `failed` or `dropped` from the chain's evidence,
  put the destination in a cooldown that doubles per failure up to a cap, and leave the money for the local entry.
  *Built:* `BRIDGE_FAIL_COOLDOWN_MS`, `fed514d4`.
- **FR-XCH-012.** A withdrawal MUST be one decision tree across chains: the user asks a value and picks the
  destination chain and token (default a stablecoin); Mamoru takes it from Stable first, then unwinds positions on
  both chains by a fixed priority; before signing a preview lists the steps (unwind, swap, bridge, send) and what
  arrives; a move that needs a bridge or swap shows a countdown; no lock and no float held by Mamoru on the
  destination. *Open* (#202). Today each chain withdraws on its own.
- **FR-XCH-013.** Fees harvested on an execution chain MUST stay on that chain as USDC; there is no bridge back on
  harvest. *Built* by construction: the allocator only bridges toward the remote bucket.
- **FR-XCH-014.** Moving value back from Monad to Base outside a withdrawal (Growth over target, a Monad pool that
  stops paying, a risk exit) is NEEDS CLARIFICATION 1.
- **FR-XCH-015.** Funds at the account's address on Ethereum MUST be shown. ETH is converted to USDC in the same
  account by one owner signature (`prepareConvert`/`submitConvert`); USDC moves to the same account on Base by another
  owner signature, by the best ranked route. With a bundler and an ERC-20 paymaster configured the move is one
  ERC-4337 v0.7 userOp that deploys the Safe, pays its gas in USDC and bridges, and a paymaster outage refuses the move
  with `BRIDGE_GAS_UNAVAILABLE` (try later); without them the relayer deploys and pays the gas. *Built:* `c189fbc5`, #211, `c1073300`. Open (#180): activation (paymaster key, relayer ETH on
  Ethereum, operator config), owned by Ot and the coordinator.
- **FR-XCH-016.** The guardian MUST be able to stop every session-key move with one pause, without stopping exits.
  *Built:* MamoruPauseGate (`d003e250`).
- **FR-XCH-017.** The user MUST see, without asking: before consent, a plain summary of what moves where; for each move,
  its state (`sending`, `burned`, `minted`, `failed`, and stuck once FR-XCH-010 exists), route, cost and time; in the
  waiting state, why Mamoru waits, without amounts. *Partial:* consent summary (#216) and `BridgeProgress` built.
  Open: route and cost on the move (#133, #97), the waiting copy (#188), the stuck reason (#245).

### Cost of every move (FR-COST)

- **FR-COST-001.** Each move MUST produce one record: move id, account, source and destination chain, provider and
  route, amount in, amount out, bridge fee, gas on the source chain (account refund) and on the destination chain
  (relayer or account), slippage of any swap leg, the quote it was chosen on and the runner-up, timestamps (proposed,
  signed, included, attested, arrived) and time in flight, final state. *Partial:* the operator journal keeps the
  timestamps for 30 days. Open (#129).
- **FR-COST-002.** The records MUST live in the D1 ledger beside the yield ledger, keyed by account and chain, through
  an additive migration. *Open* (#129).
- **FR-COST-003.** Cost per move MUST be computed in USDC with the provenance of each part; a part that was not
  observed is shown as not observed, never as zero. Gas in native units is valued at the chain's price pool at the
  block. *Open* (#129).
- **FR-COST-004.** Cost per move MUST be visible in `/ops` (by env, chain, route and account, per day) and in the
  account's move details. *Open* (#97 for `/ops`, #133 for the move).
- **FR-COST-005.** The daily report MUST carry the moves of the day and to date, cost per move in USDC and in bps of
  the amount (median and worst), time in flight, by route, and moves stuck or failed. *Open* (#246).
- **FR-COST-006.** A release that changes routing, the bridge decision, the cost ceiling or a bridge grant MUST state
  cost per move before and after from the Lab; a rise beyond a stated band blocks it until Ot accepts it. *Open*
  (#246).
- **FR-COST-007.** A new route, or a cheaper variant of one (CCTP Fast vs Standard, Across vs CCTP for Base → Monad),
  MUST enter through the Lab before it moves live funds: a fork scenario with the recipient pinned and its failure
  path, plus measured quotes for a stated period. A new session route also needs the owner's re-signed grant.
  *Open* (#246, #133).
- **FR-COST-008.** The Lab MUST simulate two chains: a `bridge_out` costs the measured fee and gas and arrives after
  the measured delay, so v6 can be compared with v2 on the same windows. *Open* (#217). Today the one-chain Lab refuses
  `bridge_out`.
- **FR-COST-009.** Whether running on Ethereum pools beats routing to Base, after gas, MUST be answered in the Lab
  before any strategy runs on Ethereum. *Open* (#244).

## Reason codes

Existing, used here: `CHAIN_UNSUPPORTED`, `REGISTRY_CHAIN_MISMATCH`, `POLICY_CHAIN_MISMATCH`,
`CONFIG_CHAIN_RPC_MISSING`, `SIGN_CHAIN_NOT_ALLOWED`, `SESSION_POLICY_UNAVAILABLE_ON_CHAIN`,
`SESSION_ATTESTATION_UNAVAILABLE_ON_CHAIN`, `CHAIN_ADDRESS_UNVERIFIED`, `SLEEVE_NOT_ACTIVE`, `LAB_CHAIN_ID_FORBIDDEN`,
`DECIDE_BRIDGE_OUT`, `DECIDE_WAIT_BRIDGE`, `BRIDGE_JOURNAL_UNAVAILABLE`.

New, added by the task that needs them:

| Code | Meaning | Ticket |
|---|---|---|
| `DECIDE_WAIT_BRIDGE` detail `session-inactive` | Destination grants revoked, expired or used up | #243 |
| `DECIDE_WAIT_BRIDGE` detail `cost-above-ceiling`, `batching` | The route is over the ceiling, or the move waits to join others | #188 |
| `DECIDE_BRIDGE_SKIPPED` detail `max-wait` | No route under the ceiling within the maximum wait; the allocation stays on Base | #188 |
| `BRIDGE_STUCK` | A move passed its deadline in `sending` or `burned` | #245 |
| `ROUTE_NO_SAFE_QUOTE` | No executable quote with a verified recipient for the signing mode | #133 |
| `MOVE_COST_NOT_OBSERVED` | A part of a move's cost could not be read; shown as not observed | #129 |

## Success criteria

| Id | Criterion | Proven by |
|---|---|---|
| SC-023 | No function resolves Base silently | CHN-01, CHN-04 |
| SC-024 | A 1,000 USDC v6 deposit ends as about 500 Stable and 350 Balance on Base and about 150 in WMON/USDC on Monad with no user action | XCH-01, LIVE-01 |
| SC-025 | Money in flight counts once and blocks a second move | XCH-02 |
| SC-026 | No session-key move pays anyone but the account on the destination | XCH-03, XCH-04 |
| SC-027 | A move over the cost ceiling waits, batches, and after the maximum wait stays on Base with a code | XCH-05 |
| SC-028 | A move to a destination with revoked sessions does not leave | XCH-06 |
| SC-029 | A stuck move alerts, shows its reason and can be finished by the owner alone | XCH-07 |
| SC-030 | A withdrawal across chains previews its steps and arrives on the chosen chain and token | XCH-09 |
| SC-031 | Every move has a ledger row with each cost part or "not observed" | COST-01 |
| SC-032 | Cost per move is in the daily report and in the release and Lab gate | COST-02, COST-03 |
| SC-033 | A route not proven in the Lab cannot move live funds | COST-04 |
| SC-034 | A signature for one chain is refused on the other | SESS-27 |

## NEEDS CLARIFICATION

The constitution does not decide these; Ot does.

1. **Moving value back to Base outside a withdrawal (FR-XCH-014).** #201 says harvested fees stay on Monad. It does not
   say whether Growth above target, a Monad pool whose APR falls, or a Risk Monitor exit on Monad brings money back to
   Base, or stays on Monad as USDC. Brais's written Happy Path (pending in `chat-mamoru`) was to cover "when a pool's
   APR falls".
2. **The cost ceiling's defaults (FR-XCH-006).** #188 is "proposed by Brais, needs Ot's GO". The mechanism is
   specified; the absolute value, the bps and the maximum wait come after a week of measured quotes, and Ot gives the
   GO.
3. **The band of the release gate (FR-COST-006).** How much may cost per move rise before a release is blocked, and in
   what unit (USDC per move or bps of the amount).

## Out of scope

- A bridge, message relayer or cross-chain liquidity contract of Mamoru's own (principle XIX).
- Strategy on Ethereum, until #244 answers.
- A third execution chain. The design does not stop one; this pack does not specify it.
- Venues other than Uniswap v3 inside a chain (v4, Aqua, ERC-4626 vaults of #210): the 18 Oct decision opens them, but
  their constitution amendment is another pack.
- Changing the passkey RP ID or the product session model.
