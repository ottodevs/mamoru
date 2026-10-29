# 002 threats: multichain execution and moving funds between chains

- Spec: `spec.md`. Plan: `plan.md`. Scenarios: `scenarios.md`.
- Base: `specs/001-mamoru-v1/threats.md`. THR-01 to THR-20, risks R-1 to R-10 and the incident cases of 001 stay in
  force, chain by chain. `specs/007-onchain-action-policy/` bounds what a leaked session key can lose on each chain.
- Date: 2026-10-29.

## 1. What changes

Controls marked **planned** are open work with their task and ticket; the rest are on `main`.

**Protected, in addition:** money between chains (it belongs to the account at every moment, and is counted once),
the independence of each chain's sleeve, and the truth of the chain on screen.

**New trust assumptions:**

- Circle's CCTP V2 contracts and attesters on each chain. Mamoru checks every attestation against the burn it
  journaled and against the attesters enabled on the destination, but cannot stop Circle from attesting or pausing.
- Quote providers (Across, Relay, LI.FI, deBridge, Circle's fee API) are oracles, not authorities: their calldata is
  only executed by a session key when its recipient is pinned by the grant, and by the owner only after decoding.
- The other chain's operator, if readiness is read from it (plan §8).

**New boundaries:**

| Boundary | One side | Other side |
|---|---|---|
| Chain and chain | Base operator, sessions, journal | Monad operator, sessions, journal. Share D1 and the Worker |
| Burn and mint | Base: TokenMessengerV2 under the session | Monad: MessageTransmitterV2, called by the relayer or anyone |
| Quote and call | A provider's answer | What a session key or the owner signs |

## 2. Assets

| Asset | Where | Who can move it |
|---|---|---|
| USDC in flight | Burned on Base, not yet minted on Monad | Nobody can redirect it: the mint recipient is in the attested message |
| Bridge session grant on Base | SmartSession on the Base Safe | The session key, within domain, recipient, caps, pause |
| Relayer MON on Monad | Operator relayer key | The Monad-side mint path, under per-mint and daily caps |
| Route and quote records | Operator journal, D1 ledger | The operator writes; the owner reads |

## 3. Test that kills the plan

Added to the five of 001:

| Test | How | What failing means | Consequence |
|---|---|---|---|
| KT-6. A session key can only pay the account across chains | XCH-03 on the fork, with the session key treated as leaked | Any bridge call under the session sends to another recipient, another domain, with a hook, a fee, or over the caps | The bridge grant is withdrawn from v6 (owner renewal to a policy without it); no automatic movement until fixed |

## 4. Threats

### THR-21 · Route provider compromise

- **Vector.** A quote API (Across, Relay, LI.FI, deBridge, Circle's fee endpoint) is compromised or wrong: it returns
  calldata to another recipient or contract, a fee far above the real one, or a fake ETA.
- **Controls:**
  - session keys never execute provider calldata: the engine builds the call itself against the registry's contract,
    and the grant pins target, selector, recipient, domain, token, fee and finality (FR-XCH-004);
  - owner-only quotes are decoded and the recipient checked before they are shown; `recipientCheck: 'none'` is never
    executable (FR-XCH-005);
  - the quote only chooses among routes already granted; a bad quote can at worst pick a worse granted route, capped by
    the ceiling once it exists (FR-XCH-006, #188). Today the engine does not quote at all (one fixed route);
  - the record keeps quote and realised cost, so a lying provider shows up in cost per move (FR-COST-001).
- **Detection.** `ROUTE_NO_SAFE_QUOTE`; realised cost far from quoted in the ledger and the daily report.
- **Scenarios.** XCH-03, XCH-04.
- **Residual risk.** A provider that quotes well but is slow. Bounded by the deadline (THR-23).

### THR-22 · Message or attestation spoofing

- **Vector.** A forged or replayed CCTP message is presented to the mint path; a fake attestation service answers the
  operator; an attestation for another burn is used to mark ours minted; a burn of someone else is counted as ours.
- **Controls:**
  - the operator verifies each attestation's signatures against the attesters enabled on the destination's
    MessageTransmitterV2, the message key against the journaled burn, the domains (6 → 15), sender and recipient the
    account, and the amount (FR-XCH-009);
  - MessageTransmitterV2 itself refuses a used nonce and a bad attestation: a spoofed message cannot mint;
  - "minted" is read from `usedNonces` on the destination, not from the attestation service;
  - only burns journaled before signing count in flight (FR-XCH-008);
  - planned (T020, #60): the CCTP contracts pinned by code hash in each chain's registry (FR-CHN-004). Today
    TokenMessengerV2 is pinned only in `base.json`, MessageTransmitterV2 is a constant, and boot checks only Monad's
    `localDomain()`.
- **Detection.** A burn whose attestation never verifies goes stuck (THR-23).
- **Scenarios.** XCH-01, XCH-02, XCH-07.
- **Residual risk.** A compromise of Circle's attesters themselves is outside Mamoru's control; it is the stablecoin
  issuer's risk, which the account holds anyway.

### THR-23 · Stuck funds

- **Vector.** A burn is never attested (Circle down, a chain halted), the mint reverts, the relayer has no MON or hits
  its daily budget, an Across deposit is never filled. The money leaves Base and does not arrive; the account's next
  bridges block behind it.
- **Controls:**
  - planned (T033, #245): deadline per state, `BRIDGE_STUCK`, an ops alert and the reason on the move (FR-XCH-010).
    Until then a stuck burn retries forever, only logs, and blocks the account's later bridges;
  - the money stays counted once in flight, never zero, never twice (FR-XCH-008, `INV-ONCE-IN-FLIGHT`);
  - owner recovery without Mamoru: anyone, the owner included, can mint with the public attestation
    (`destinationCaller` 0); an Across refund returns to the account after `fillDeadline`;
  - one move in flight per account bounds what can be stuck to one move's caps.
- **Detection.** Today the operator log and the account's move stuck in `burned`. Planned: `BRIDGE_STUCK` and the
  daily report's stuck count (FR-COST-005, #246).
- **Scenarios.** XCH-07.
- **Residual risk.** Time: money stuck earns nothing. Bounded by per-call caps. R-11.

### THR-24 · Griefing through forced bridges

- **Vector.** Someone makes the engine bridge often or at a bad price: dust deposits that each trigger a move, a
  manipulated Monad price that makes Growth look short, a failing destination that makes the engine retry, or a
  spike in fees.
- **Controls:**
  - entry minimum and rebalance band before any `bridge_out`; one move in flight per account (FR-XCH-002);
  - the remote value is at the TWAP of each pool, never `slot0`;
  - planned (T031, #188): the cost ceiling with wait and batch, and the maximum wait that leaves the money on Base
    (FR-XCH-006). Today CCTP Standard has no bridge fee, so the exposure is gas on both chains per move;
  - the failure cooldown that doubles to 24 hours (FR-XCH-011);
  - per-call and total caps in the grant, and the guardian's pause (FR-XCH-004, FR-XCH-016).
- **Detection.** Cost per move and moves per account in the daily report; cooldowns in the operator log.
- **Scenarios.** XCH-05, XCH-06, XCH-03.
- **Residual risk.** Below the entry minimum nothing moves; a determined depositor pays their own deposits' gas.

### THR-25 · Relayer drain on the destination chain

- **Vector.** The Monad relayer pays every mint. A flood of burns (real or forged), a mint that keeps reverting, or a
  high Monad gas price empties it, which then stalls every account's mints; on Monad gas is charged on the limit.
- **Controls:**
  - mints only for burns the Base operator journaled itself, never for arbitrary messages (FR-XCH-009);
  - `MONAD_MINT_GAS_CAP`, `MAX_MONAD_GAS_PRICE_WEI`, a daily MON budget and a daily count, and the 10 MON protocol
    reserve kept;
  - reverted mints retried with doubling waits, at most three times;
  - the mint is permissionless: if the relayer is empty, the owner or anyone can mint (THR-23);
  - relayer spend recorded per move and per day (FR-AA-007, FR-COST-001).
- **Detection.** Daily budget reached; `BRIDGE_STUCK` across several accounts at once; relayer balance in `/ops`.
- **Scenarios.** XCH-07 with `relayer-no-mon`.
- **Residual risk.** The daily budget bounds the loss; a stall delays mints until Ot funds it. R-12.

### THR-26 · Destination that cannot work

- **Vector.** The Monad sleeve's sessions are revoked or expired while SmartSession stays installed; the money arrives
  and sits idle in the owner's Safe on Monad, not lost but not working, and the engine keeps sending more.
- **Controls:** planned (T032, #243): readiness reads the grants (FR-XCH-007). Built: one move in flight; the cooldown.
- **Scenarios.** XCH-06.
- **Residual risk.** Revocation between the readiness read and the arrival: that one move lands idle; the next one
  waits.

### THR-27 · Replay across chains with the same address

- **Vector.** A userOp or owner transaction seen on one chain is resent on the other, where the account has the same
  address; a leaked session key is tried on the other sleeve.
- **Controls:** the chain id in the userOp hash and in the Safe's EIP-712 domain; session keys per account and chain;
  sessions enabled per chain with that chain's Safe nonce (FR-ACC-015).
- **Scenarios.** SESS-27.
- **Residual risk.** A leaked key affects only its sleeve, within its policy (007).

### THR-28 · Silent default chain

- **Vector.** A caller forgets the registry and resolves Base addresses on Monad; a call to an address with no code
  "succeeds" with empty data.
- **Controls:** no default (FR-CHN-002); registry per chain checked against the piece's chain; write registry refuses a
  chain whose account stack differs; simulation deltas against the intent.
- **Scenarios.** CHN-01, CHN-04, CHN-06.
- **Residual risk.** Until T020's last unit, the deprecated default exists; the call-site count may only go down.

### THR-29 · Gas charged on the limit

- **Vector.** On Monad a loose gas limit is paid in full, by the account (userOp) or the relayer (outer transaction,
  mint).
- **Controls:** estimate plus a stated margin, never a constant (FR-AA-006); mint gas cap; spend recorded apart
  (FR-AA-007).
- **Scenarios.** `monad-writes.test.ts`, LIVE-01.
- **Residual risk.** The fork charges gas used, so the real ceiling is measured on mainnet under the cap. R-15.

### THR-30 · Two operators, one D1

- **Vector.** The Base and Monad operators write to the same D1; a key without `chain_id` mixes rows or metrics.
- **Controls:** `chain_id` in sleeve, activity and projection keys (`0017`), metrics by chain (FR-CHN-009); separate
  state directories and relayer keys (FR-CHN-006).
- **Scenarios.** ENG-01, ENG-02.

## 5. Residual risks accepted

| Id | Risk | Ceiling | Where seen |
|---|---|---|---|
| R-11 | Money stuck between chains earns nothing until recovered | One move's per-call cap per account | THR-23, daily report |
| R-12 | The Monad relayer runs dry and mints stall | The daily MON budget | THR-25, `/ops` |
| R-13 | Circle's attesters or contracts fail or pause | The USDC in flight | THR-22 |
| R-14 | Quotes and realised cost differ | The cost ceiling per move | THR-21, ledger |
| R-15 | The real gas cost on Monad is only measured on mainnet | The margin per operation, under the account cap | THR-29, LIVE-01 |

## 6. Incident response

Cases A to F of 001 apply per chain. Added:

| Case | Trigger | Steps |
|---|---|---|
| K. Stuck move | `BRIDGE_STUCK` | 1. Check Circle's status and the attestation. 2. Fund the relayer if that is the cause. 3. Otherwise mint by hand with the attestation, or tell the owner how (`docs/walkaway.md`). 4. Note it on the ticket and in the daily report |
| L. Bridge grant suspected | KT-6 fails, or a burn with a foreign recipient appears | 1. Guardian pause (MamoruPauseGate). 2. Turn off `multichain_v6`. 3. Owners renew to a policy without the bridge grant. 4. Fix, then the Lab, then the high-stakes review |
| M. Relayer budget hit | Daily mint budget reached | 1. Mints wait until the next UTC day. 2. Ot decides whether to raise the budget. 3. Accounts stay counted in flight |
| N. Route provider wrong | Realised cost far from quoted, or `ROUTE_NO_SAFE_QUOTE` for every move | 1. Drop the adapter from `quoteAll` by setting. 2. Moves wait or use the remaining granted route |
