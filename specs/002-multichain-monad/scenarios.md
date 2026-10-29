# 002 scenarios: multichain execution and moving funds between chains

- Spec: `spec.md`. Plan: `plan.md`. Base: `specs/001-mamoru-v1/scenarios.md`, whose rules, invariants and scenarios
  stay in force, chain by chain.
- Date: 2026-10-29.

Each open task is accepted by scenarios from this catalog or from 001. Each scenario cites requirement ids. Expected
results are reason codes, states and invariants, never Packaging thresholds or the values of engineering parameters
(margins, ceilings, deadlines).

**Status** says whether the scenario exists today: **exists** (with the test file), **to write** (with the task and its ticket).

## 1. Rules added to 001

1. **One manifest per chain.** `scenarios/manifest.json` (Base, fork chain id 31337) and
   `scenarios/monad/manifest.json` (Monad, fork chain id 314143). The Ethereum entry scenarios
   (`packages/scenarios/l1/`) fork at 31337. A fork chain id is never in `FORBIDDEN_LAB_CHAIN_IDS`.
2. **Two ids.** The source id (8453, 143, 1) picks registry and policy; the execution id is what anvil answers. Every
   signature, grant, D1 row and provenance of a scenario carries the execution id.
3. **Two forks at once.** A cross-chain scenario runs the Base fork and the Monad fork side by side. CCTP attestations
   come from a local attester key enabled on the Monad fork by a declared fixture (`fx-cctp-local-attester`), never
   from Circle; the scenario says so in its report. That is the only code or state change on the fork that a scenario
   may make outside a declared perturbation.
4. **No mainnet in a scenario.** Signing or sending against 1, 8453 or 143 is `LAB_CHAIN_ID_FORBIDDEN`.

## 2. Invariants added

| Invariant | Checks |
|---|---|
| `INV-RECIPIENT-XCHAIN` | Every bridge call's recipient on the destination is the account (CCTP `mintRecipient`, Across `recipient` and `depositor`) |
| `INV-ONCE-IN-FLIGHT` | The account's combined value counts a move in flight exactly once, at every review between burn and arrival |
| `INV-NO-DEFAULT-CHAIN` | Zero registry, policy or chain resolutions without an explicit chain in the run |
| `INV-COST-OBSERVED` | Every cost part of a move is a number with provenance or "not observed", never an invented zero |

## 3. Fixtures and perturbations added

| Fixture | Prepares |
|---|---|
| `fx-two-chains` | The same Safe deployed on both forks, v6 grants on Base, v5 sleeve grants on Monad |
| `fx-cctp-local-attester` | A local attester key enabled on the Monad fork's MessageTransmitterV2, and an attestation stub that signs a burn seen on the Base fork |
| `fx-sleeve-revoked` | `fx-two-chains` with the Monad sessions revoked by the owner, SmartSession still installed |
| `fx-quotes` | Recorded quotes per provider for 8453 → 143 (fee, ETA, calldata), replayed by a local quote stub |

| Perturbation | Effect |
|---|---|
| `attestation-withheld` | The stub never returns an attestation for one burn |
| `mint-reverts` | `receiveMessage` reverts on the Monad fork for one burn |
| `relayer-no-mon` | The Monad relayer has less MON than one mint |
| `quote-spike` | Every quote's fee is raised above the ceiling for a stated time |
| `quote-wrong-recipient` | One provider returns calldata whose recipient is not the account |

## 4. Chains and registries: CHN-01 to CHN-06

| Id | Requirements | Fork | Action | Expected | Status |
|---|---|---|---|---|---|
| CHN-01 | FR-CHN-001, FR-CHN-002, FR-CHN-004 | none (types and unit) | a) `entry`, `address`, `nameOf` called without a registry. b) `registryFor(8453)`, `registryFor(143)`, `registryFor(1)`, `registryFor(10)`. c) `chainOf` of each | a) Type error, once T020's last unit lands. b) Base, Monad, Ethereum registries; `CHAIN_UNSUPPORTED` for 10. c) Descriptors with roles `execution`, `execution`, `entry` | to write (T020, #60); b) for 8453 and 143 exists in `packages/domain/src/chains.test.ts` |
| CHN-04 | FR-CHN-002, FR-CHN-003 | `catalog-v1` | The 001 catalog after every T020 and T024 unit | Same report as before, apart from dates and versions | exists (`packages/uniswap-v3/src/calls.test.ts` bytes check); rerun per unit of T020 (#60) and T024 (#64) |
| CHN-05 | FR-CHN-003 | a scenario with fork chain id 1, 8453, 143, 11155111 | The runner reads it | `LAB_CHAIN_ID_FORBIDDEN` before the first step for each | to write (T020, #60); exists for 8453 and 143 (`assertLabChainId`) |
| CHN-06 | FR-CHN-002, FR-CHN-004 | `catalog-monad`, `fx-two-chains` | Build, without sending, the Monad entry, harvest, exit and grant batches with `monadRegistry`; decode every nested address | Every address is in `monad.json` under its name; none of Monad's differing entries matches a `base.json` address; `INV-NO-DEFAULT-CHAIN` | to write (T020, #60) |

## 5. Sessions per chain: MON-04, SESS-26, SESS-27

| Id | Requirements | Fork | Action | Expected | Status |
|---|---|---|---|---|---|
| MON-04 | FR-ACC-012 | `catalog-monad` | a) `monad.json` without TimeFramePolicy, or with a code hash other than Base's; activate. b) Both present with Base's hash | a) `SESSION_POLICY_UNAVAILABLE_ON_CHAIN`, no call. b) Same policy bytes as Base for the same grant, registry addresses apart | in part (`monad-writes.test.ts`); pinned registry case to write (T022, #62) |
| SESS-26 | FR-ACC-012 | `catalog-monad` | A valid userOp after `time-warp` past `validUntil`; userOps until the usage limit, then one more | Both refused (`CHAIN_REJECTED_VALIDATION`); `SESSION_EXPIRED` on the first | to write (T022, #62) |
| SESS-27 | FR-ACC-015 | both forks, `fx-two-chains` with the same session key and grants on both | a) A userOp signed for the Base fork sent to the Monad fork, and back. b) An owner transaction signed for one sent to the other | a) `CHAIN_REJECTED_VALIDATION`. b) Reverts on the signature. The same bytes re-signed for the right chain id validate (control) | to write (T022, #62) |

## 6. Engine and D1 per chain: ENG-01 to ENG-03, MB-05

| Id | Requirements | Fork | Action | Expected | Status |
|---|---|---|---|---|---|
| ENG-01 | FR-CHN-009 | both forks, local D1 | One sync per chain; then one with `RPC_URL_143` missing | Rows per `accountKey` with their `chain_id`; second run logs `CONFIG_CHAIN_RPC_MISSING` for 143 and syncs Base | to write (T024, #64) |
| ENG-02 | FR-CHN-009 | both forks | Daily metrics | One `metrics_daily` row per day and chain; none sums both | to write (T024, #64) |
| ENG-03 | FR-CHN-009 | none: local D1 copy | Apply `XXXX_metrics_by_chain.sql` | Row count before equals after; Base rows carry 8453 | to write (T024, #64) |
| MB-05 | FR-CHN-010 | none: MultiBaas does not index the fork | Real `Swap` query on a known Monad pool, compared with `slot0()` at the same block | `MB_CHAIN_INDEXING_OK` with 143, or `MB_CHAIN_INDEXING_ABSENT` and MultiBaas off for 143 | to write (T024, #64) |

## 7. Moving funds: XCH-01 to XCH-10

| Id | Requirements | Fork | Action | Expected | Status |
|---|---|---|---|---|---|
| XCH-01 | FR-XCH-001, FR-XCH-002, FR-XCH-008, FR-XCH-009 | both forks, `fx-two-chains`, `fx-cctp-local-attester` | Deposit 1,000 USDC on Base; reviews on both operators until quiet | `DECIDE_BRIDGE_OUT`; burn `sending` → `burned` → `minted`; the Monad operator enters WMON/USDC; about 500 Stable, 350 Balance on Base, about 150 Growth on Monad; `INV-RECIPIENT-XCHAIN` | engine side exists (`packages/scenarios/driver/engine-bridge.test.ts`, `apps/mamoru-operator/test/bridge-monad.test.ts`); two-fork run to write (T037, #217) |
| XCH-02 | FR-XCH-008 | as XCH-01 | Reviews on Base between burn and mint, and right after the mint before the sleeve is read | `DECIDE_WAIT_BRIDGE` (in flight); `INV-ONCE-IN-FLIGHT` at every review; no second burn | exists in part (`bridge-monad.test.ts`); two-fork run to write (T037, #217) |
| XCH-03 | FR-XCH-004 | `catalog-v1`, v6 grants | With the bridge session key: a burn to another domain, recipient, caller, fee, finality, token, spender, over the per-call cap; `depositForBurnWithHook`; a call to any other bridge contract | Each refused by precheck and by the session on-chain (`CHAIN_REJECTED_VALIDATION`) | exists (`engine-bridge.test.ts` precheck; `537caa34`); on-chain half to write (T030, #133) |
| XCH-04 | FR-XCH-003, FR-XCH-005 | none: quote stub, `fx-quotes`, `quote-wrong-recipient` | Quote all providers; select for `session-key` and for `owner-only` | The wrong-recipient quote is dropped; no aggregator quote in `session-key`; the pick is the best net output among the rest; with none left `ROUTE_NO_SAFE_QUOTE` | selector exists (`packages/routing/src/selector.test.ts`); engine use to write (T030, #133) |
| XCH-05 | FR-XCH-006 | `catalog-v1`, `fx-quotes`, `quote-spike` | Deposits under the spike, reviews across the wait, then past the maximum wait | `DECIDE_WAIT_BRIDGE` detail `cost-above-ceiling`; later deposits join the same gap (`batching`); when the spike ends one move carries them all; with the spike held past the maximum wait, `DECIDE_BRIDGE_SKIPPED` detail `max-wait` and the allocation on Base | to write (T031, #188) |
| XCH-06 | FR-XCH-007 | both forks, `fx-sleeve-revoked` | Deposit on Base, review | `DECIDE_WAIT_BRIDGE` detail `session-inactive`; no burn; the app shows the reason on Growth | to write (T032, #243) |
| XCH-07 | FR-XCH-010, FR-XCH-017 | both forks, `attestation-withheld`; then `relayer-no-mon`; then `mint-reverts` | A burn, time past the deadline; then the owner mints by hand with the attestation | `BRIDGE_STUCK`, alert recorded, state `stuck` in journal and ledger, the reason on the move, the account's next bridge blocked, counted once; after the owner's mint, `minted` with no operator transaction | to write (T033, #245) |
| XCH-08 | FR-XCH-003, FR-XCH-017, FR-COST-001 | both forks, `fx-quotes` | XCH-01 with two session routes granted (after T030 unit 3) | The move's record names the chosen route and the runner-up; the app's move detail shows route, cost and time | to write (T030, #133) |
| XCH-09 | FR-XCH-012 | both forks, positions on both | Withdraw 50 USDC worth to Base as USDC; then to Monad as USDC | Stable first, then unwinds by priority across chains; the preview lists the steps and the amount that arrives; bridge steps toward the destination only, recipient the account; no float | to write (T038, #202) |
| XCH-10 | FR-ACC-016 | none: Worker test | `POST /api/sleeves {chainId: 143}` on the production host with the flag on; with a derivation mismatch | Row created; `CHAIN_ADDRESS_UNVERIFIED` on the mismatch | to write (T040, #240) |

Ethereum entry (FR-XCH-015) is accepted by the existing fork runs `apps/mamoru-operator/test/e2e-bridge-out.ts` and
`e2e-l1-userop.ts` (`packages/scenarios/l1/`); a ledger row per entry move is added to them by T034.

## 8. One signature: SIG-01

| Id | Requirements | Fork | Action | Expected | Status |
|---|---|---|---|---|---|
| SIG-01 | FR-ACC-017 | both forks, `fx-two-chains` before the Monad sessions are enabled | The owner signs once over both chains' session enables (the mechanism #230 picks); the signature is presented on each fork; then on a third fork chain id not in the signed set | Sessions enabled on both forks from the one signature; refused on the chain id outside the set; each enable bound to its own chain's Safe nonce | to write (T039, #230), only if the spike's verdict is yes |

## 9. Cost: COST-01 to COST-06

| Id | Requirements | Fork | Action | Expected | Status |
|---|---|---|---|---|---|
| COST-01 | FR-COST-001, FR-COST-002, FR-COST-003, FR-AA-007 | both forks, as XCH-01; then with the Monad price pool unreadable | Read the ledger after each state | One row per move; parts filled as each state lands; account gas and relayer gas apart; with the price unreadable, `MOVE_COST_NOT_OBSERVED` and `cost_usdc` null, never 0; `INV-COST-OBSERVED` | to write (T034, #129) |
| COST-02 | FR-COST-004, FR-COST-005 | none: rows in a local D1 | a) `/ops` cost view. b) The daily report on a day with moves and on a day without | a) By env, chain, route and account per day, from the rows. b) Median and worst cost per move in USDC and bps, time in flight, stuck and failed; "no moves" on the empty day | to write (T035, #97, T036, #246) |
| COST-03 | FR-COST-006 | Lab sweep | A change that raises cost per move beyond the band | The gate prints before and after and fails until accepted | to write (T036, #246) |
| COST-04 | FR-COST-007 | none: static check of the policies | A live policy names a route grant with no Lab result recorded for it | The check fails | to write (T036, #246) |
| COST-05 | FR-COST-008 | Lab, TRAIN and TEST windows | v6 against v2 with the measured CCTP Standard cost and delay | Both run; bridge moves arrive after the delay and cost the measured amount; the report states the route model's source | to write (T037, #217) |
| COST-06 | FR-COST-009 | Lab, Ethereum replay | L1 pools against routing to Base after gas | A result note; no Ethereum strategy is added | to write (T041, #244) |

## 10. Mainnet: READY-01 and LIVE-01 (Monad)

| Id | Requirements | Action | Expected | Status |
|---|---|---|---|---|
| READY-01 | FR-CHN-005, FR-CHN-006 | The Monad operator on mainnet with writes off | Boots, reads, signs nothing; unit and runbook in place; rollback rehearsed | to write (T028, #68) |
| LIVE-01 | FR-CHN-005, FR-CHN-007, FR-XCH-001 to FR-XCH-009, FR-COST-001 | After Ot's action: one own account under the cap moves to v6 | Bridge, mint, entry and harvest on Monad; journal, ledger and dashboard reconciled with `eth_call` on both chains | to write (T028, #68) |

## 11. Traceability

| Requirements | Scenarios |
|---|---|
| FR-CHN-001 to FR-CHN-004 | CHN-01, CHN-04, CHN-05, CHN-06 |
| FR-CHN-005 to FR-CHN-007 | READY-01, LIVE-01 (built; regression in the operator tests) |
| FR-CHN-008 | CHN-01 (policy part), 001 SIGN scenarios |
| FR-CHN-009, FR-CHN-010 | ENG-01 to ENG-03, MB-05 |
| FR-CHN-011 | COST-06, the entry fork runs |
| FR-ACC-012, FR-ACC-013 | MON-04, SESS-26 |
| FR-ACC-014, FR-ACC-016 | XCH-10 |
| FR-ACC-015 | SESS-27 |
| FR-ACC-017 | SIG-01 |
| FR-AA-006 | `monad-writes.test.ts` (built), LIVE-01 |
| FR-AA-007 | COST-01 |
| FR-XCH-001, FR-XCH-002 | XCH-01 |
| FR-XCH-003 | XCH-04, XCH-08 |
| FR-XCH-004 | XCH-03 |
| FR-XCH-005 | XCH-04 |
| FR-XCH-006 | XCH-05 |
| FR-XCH-007 | XCH-06 |
| FR-XCH-008, FR-XCH-009 | XCH-01, XCH-02 |
| FR-XCH-010 | XCH-07 |
| FR-XCH-011 | `bridge-monad.test.ts` (built) |
| FR-XCH-012 | XCH-09 |
| FR-XCH-013 | XCH-01 (harvest on Monad stays) |
| FR-XCH-014 | none until NEEDS CLARIFICATION 1 is answered |
| FR-XCH-015 | `e2e-bridge-out.ts`, `e2e-l1-userop.ts` |
| FR-XCH-016 | `d003e250` tests (built) |
| FR-XCH-017 | XCH-06, XCH-07, XCH-08 |
| FR-COST-001 to FR-COST-003 | COST-01 |
| FR-COST-004, FR-COST-005 | COST-02 |
| FR-COST-006 | COST-03 |
| FR-COST-007 | COST-04 |
| FR-COST-008 | COST-05 |
| FR-COST-009 | COST-06 |
