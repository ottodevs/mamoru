# 009: One treasury Safe pays for every gas wallet

Ticket: otto/mamoru#256. Status: spec. Nothing here is built; no task below says "implement now".

## Problem

Every key that sends a transaction holds its own native gas, on every chain it writes to, and each one is funded
by hand from /ops Money → Funding. On 2026-11-01 that is six balances on three chains:

| Wallet | Chain | Balance (read 2026-11-01) | Pays |
|---|---|---|---|
| Base operator relayer `0x8F7D…b5A0` | Base | 0.0163 ETH | Safe deploys, owner execs, activation top-ups, `handleOps`, CCTP mints |
| same key | Ethereum | 0.0042 ETH | bridge-out `handleOps` fronting (refunded by the Pimlico paymaster) |
| same key | Monad | 2.21 MON | CCTP mints on Monad |
| Monad operator relayer `0xE411…5C88` | Monad | 104.1 MON | Monad deploys, execs, top-ups, bundling |
| Guardian `0xA8E6…1FdD` | Base | 0 ETH | `pause(account)` / `unpause` on the action policies |
| same key | Monad | 0 MON | same, on Monad |

Nothing refills any of them, and no alert fires when one runs low: the operator logs a line and /ops shows a row. The
guardian has never been funded, so today no one can pause an account on either chain. Each new chain adds a relayer
float and a guardian float.

Ot (2026-11-01): this does not scale and is not manageable. One place should hold the project's gas money, and the
project should draw from it.

## Decision (approved by Ot, 2026-11-01)

1. **One treasury Safe.** It is the only thing Ot funds, and it holds only project money (gas floats), never user
   funds.
2. **Automatic refill.** The operator tops up a fixed list of the project's own gas wallets from the treasury. It goes
   through a small Mamoru Safe module that computes on chain how much each wallet lacks, and can do nothing else.
3. **The treasury becomes the guardian** in every policy deployed from now on. A pause is a call the treasury makes:
   - the owners sign a Safe transaction;
   - or a watchdog key calls the module's `pause`, which can only pause, only listed policies.
4. Policies already live keep their immutable guardian EOA. That EOA is funded once. It stays on the refill list and
   becomes the break-glass submitter of owner-signed transactions.

Several keys stay: that is the security model (a relayer compromise must not stop the brake; a brake compromise must
not move money). What goes away is a separate float per key that a person tops up.

## Requirements

### Treasury

- **TRS-01** The treasury is a Safe 1.4.1:
  - SafeL2 singleton `0x29fc…C762`;
  - SafeProxyFactory `0x4e1D…ec67`;
  - CompatibilityFallbackHandler `0xfd07…Ec99`.

  It is created with `createProxyWithNonce` and the same initializer and salt nonce on Base, Ethereum and Monad, so it
  has one address on all three. All three contracts had code on all three chains on 2026-11-01. T1 compares their code
  hashes with Safe's published ones, not only "has code".
- **TRS-02** The initializer sets owners, threshold and fallback handler only. Modules are enabled after creation by
  an owner transaction on each chain.
- **TRS-03** The registry holds the treasury address per chain, and the registry is the source of truth, not "the
  same address everywhere". The same address extends to a new chain only while the original owner set is intact on
  every chain.
  - After a rotation, a new chain gets a new treasury with the current owners, and that chain's registry entry names
    it.
  - The original address on a chain where the treasury was never deployed is treated as hostile: anyone can deploy it,
    and rotated-out keys control it.
- **TRS-04** Owners are fresh keys used for nothing else. Funding comes from an exchange withdrawal or another fresh
  source, never from a personal wallet. T0 and the manual fallback (TRS-31) use the same source.
  - **Limit, stated:** the relayers were funded by hand before this spec. If any of those transfers came from an
    Ot-linked wallet, the first refill links the treasury to that wallet. The treasury is "not Ot's personal wallet",
    not unlinkable. Every balance stays public, as today.
- **TRS-05** NEEDS CLARIFICATION (Ot): owners and threshold. Recommendation: 2 of 3, being a hardware wallet, a second
  device and a recovery key kept offline. A passkey owner needs Safe's WebAuthn signer, which is not checked on Monad.
- **TRS-06** The treasury never sends to a user's account and never receives from one. Constitution I holds, and
  per-account gas reserves stay out of scope.

### Refill module

- **TRS-10** `MamoruTreasuryModule`, one deployment per chain, enabled on the treasury by an owner transaction. It
  holds only configuration and its own rate counter: it never receives or holds funds, and all its state is set by the
  treasury. Zodiac Roles is not used. The cap must hold on plain value transfers with empty calldata, and on Roles v2
  that depends on unverified condition semantics. A purpose-built module of a few dozen lines makes the bound a code
  property that a fork test can check.
- **TRS-11** Configuration, writable only by the treasury (`msg.sender == treasury`):
  - `wallets[addr] = {low, target}` per chain;
  - `refillers` and `watchdogs`, two disjoint key sets;
  - `capPerDay`;
  - `policies`, the policies whose `GUARDIAN` is the treasury.
- **TRS-12** `refill(address wallet)`, refillers only:
  - `wallet` must be listed;
  - when the balance is at or above `low`, it returns without sending, without reverting and without an event (a
    no-op, so a race between ticks or operators is not a failure);
  - otherwise `amount = target − wallet.balance`, computed in the call, must fit in what is left of `capPerDay` for
    the current UTC day;
  - it sends with `execTransactionFromModule(wallet, amount, "", Call)`, reverts if that returns false, and emits
    `Refilled(wallet, amount)`.

  The caller never chooses the amount or the recipient beyond the list. A second call in the same block, or by another
  operator, finds the wallet at target and is a no-op. On a self-refill the EVM has already held the call's
  `gasLimit × maxFeePerGas` from the caller's balance when the module reads it, so `amount` overshoots `target` by at
  most that hold. The unused part comes back after the call, and `capPerDay` includes that headroom (TRS-15).
- **TRS-13** `pause(address policy, address account)`, watchdogs only: `policy` must be listed. The module calls
  `policy.pause(account)` through the treasury, so `msg.sender` at the policy is the treasury, and it reverts if that
  fails. No `unpause` exists in the module: the owners unpause with a Safe transaction, and an owner's renewal also
  ends a pause (`isPaused` is `pausedAt == generation + 1`: V2 `:614`, V3 `:861`; `pause` and `unpause` check
  `msg.sender == GUARDIAN`: V2 `:600-612`, V3 `:847-859`).
- **TRS-14** The list per chain (phase 1) and its `low` / `target`:

  | Chain | Wallet | low | target |
  |---|---|---|---|
  | Base | Base relayer | 0.005 ETH | 0.02 ETH |
  | Base | Guardian EOA | 0.0002 ETH | 0.0005 ETH |
  | Ethereum | Base relayer | 0.006 ETH | 0.015 ETH |
  | Monad | Monad relayer | 16 MON | 30 MON |
  | Monad | Base relayer | 2 MON | 5 MON |
  | Monad | Guardian EOA | 0.5 MON | 1 MON |

  - These are starting values. T4 replaces them before T3 turns on, from 14 days of measured burn per wallet (balance
    history in `operator_metrics` and on chain): `low = refillReserve + p95 spend per review interval × 3`, and
    `target − low` at least one p95 day of spend.
  - Monad values wait on T4's check of Monad's reserve-balance rule (TRS-19).
  - The table lives in `packages/registry`, read by the operator and copied to the landing, as `deployments.ts` is.
- **TRS-15** `capPerDay` per chain is the sum of the targets, plus two p95 days of measured burn per wallet, plus one
  `refillReserve` per wallet for the self-refill overshoot (TRS-12). Every wallet can then be filled from empty and
  still be refilled on a busy day. T4 sets the values from its measurement. Placeholders until then:
  - Base 0.05 ETH;
  - Ethereum 0.03 ETH;
  - Monad 100 MON.

  A thief holding a refiller key can move at most that per day, only into listed wallets. That includes draining the
  wallet whose key they hold and having it refilled again, up to the cap. The cap resets at 00:00 UTC, so the worst
  case is two caps within seconds of midnight, then one per day.
- **TRS-16** Refillers are exactly one operator key per chain: the prod relayer that writes there. The beta operator
  is never a refiller.
  - Base: the Base relayer.
  - Ethereum: the Base relayer.
  - Monad: the Monad relayer.

  Each chain has a fixed refill transaction shape and a `refillReserve` derived from it:

  | Chain | `gasLimit` | `maxFeePerGas` ceiling | L1 data fee bound | `refillReserve` |
  |---|---|---|---|---|
  | Base | 100k | 0.5 gwei | 0.00005 ETH | 0.0001 ETH |
  | Ethereum | 100k | 10 gwei (above the 3 gwei bridge-out ceiling, `bridge-out.ts:126`, so a refill never waits behind it) | none | 0.001 ETH |
  | Monad | 100k | 500 gwei (the Monad mint ceiling, `bridge-monad.ts:41-44`) | none | 0.05 MON, pending TRS-19 |

  - `refillReserve = gasLimit × ceiling + L1 bound`. Every refill is sent with exactly that `gasLimit` and a
    `maxFeePerGas` at or under the ceiling. When the network asks more (or Base's L1 fee estimate exceeds the bound),
    the refill waits and TRS-18 posts once.
  - The upfront hold of a refill is therefore at most `refillReserve`. That bounds the self-refill overshoot of TRS-12,
    and it is the headroom term in TRS-15.
  - The `Relayer` refuses any send other than `refill` whose worst-case cost would leave less than `refillReserve`:
    `balance − value − gasLimit × maxFeePerGas − max(L1 fee bound, that send's L1 fee estimate) < refillReserve`.
    On Base the L1 fee is set at inclusion, not by a transaction field, so the bound is an estimate with a wide margin
    (0.00005 ETH against today's fee for a small transaction). Ordinary work can therefore never
    strand the only refiller below the cost of refilling itself. The refusal is logged and the work waits for the
    next refill.
  - Every relayer's `low` in TRS-14 is above its chain's `refillReserve`, and T1 asserts it.

- **TRS-17** The operator reads each listed balance on its review cadence and calls `refill(wallet)` for each one
  under `low`:
  - one call in flight per chain;
  - the call goes through the same one-send-at-a-time `Relayer` and the same journal as every relayer send
    (constitution XI);
  - a refill is "done" only when the receipt has status 1 and carries the module's `Refilled(wallet, amount)` event.
    The wallet's balance is not compared with `amount`, because a self-refill also pays its own fee (and on Base an L1
    data fee).
  - a no-op (no event) is recorded as "already at target", not as a failure.
- **TRS-18** Alerts in Mattermost `#mamoru-ops`:
  - any failed refill, once per wallet and day;
  - a chain's `capPerDay` used past 80%, or a wallet refilled more often than its measured p95 rate allows. Either
    suggests a stolen key or a change in load;
  - the treasury on a chain holding less than the larger of `capPerDay` and the last 7 days' refills, with the amount
    to send. The `capPerDay` floor makes the alert work from day one, with no history.
- **TRS-19** Monad: T4 confirms, before any value moves, whether Monad's reserve-balance and gas-limit charging rules
  apply to the treasury and the module, with a live transfer of 0.1 MON. If they do, `low` / `target` and the
  treasury alert include the reserve.
- **TRS-20** Every refill is a row: chain, wallet, amount, tx hash, balance before and after. It is mirrored to D1 for
  /ops.

### Guardian

- **TRS-30** From the next deployment of each policy on, `GUARDIAN` is that chain's treasury address from the
  registry (TRS-03). A deploy script refuses unless the treasury on that chain:
  - has code with the expected singleton;
  - has the expected `getOwners` and `getThreshold`;
  - has the module enabled.

  The policy's address is added to the module's `policies` by an owner transaction in the same release.
- **TRS-31** Ot pauses with an owner-signed Safe transaction calling `pause(account)`. Someone has to submit it and pay
  its gas, so each chain has a break-glass submitter. It is the legacy guardian EOA, which is on the refill list
  (TRS-14) and unlinked to Ot (TRS-04).
- **TRS-32** The watchdog is a key of its own, never a relayer. Until it exists (T7), no automatic pause exists, and
  pausing is the owners' or the legacy guardian's job.
- **TRS-33** Policies live today keep guardian `0xA8E6…1FdD`: V2 on Base, V2 on Monad, and V3 on Monad (deployed
  2026-10-31, tx `0xebe22a44…`). On them, only that EOA can pause or unpause: the module's `pause` cannot reach them.
  - NEEDS CLARIFICATION (Ot): where the key of `0xA8E6…1FdD` is kept and who can use it. If it is lost, no account
    running a live policy has a brake.
- **TRS-34** NEEDS CLARIFICATION (Ot + the #251 owner), blocking T6: V3 on Base is not deployed. There was no code at
  its pinned `0xDD2E…6749` on 2026-11-01.
  - Re-pinning its `GUARDIAN` to the treasury moves V3-Base's address and the PauseGate bound to it
    (`GATE_V3_BASE_PINNED`).
  - It leaves V3-Monad's address unchanged.
  - Allowed only if no account, deployed or counterfactual, commits to V3-Base. Checked against D1 `accounts`, the
    operator's `accounts.json`, and every predicted address the app has shown or that holds funds.
  - If any does, V3-Base deploys as pinned, with the EOA guardian, and the treasury becomes guardian only with the next
    version.

### Console

- **TRS-40** /ops Money → Funding leads with the treasury. Per chain it shows:
  - the treasury balance;
  - how long it lasts at the last 7 days' refills;
  - the address to fund.

  It has one action, "Fund the treasury".
- **TRS-41** The per-wallet table stays as a read-only health view: holds, low, target, last refill. The multi-wallet
  "Send funds" plan becomes a manual fallback behind a disclosure, funded from the same source as the treasury
  (TRS-04).
- **TRS-42** The refill log (TRS-20) is a table under it.

## Threats

| Threat | Bound |
|---|---|
| Refiller key stolen | At most `capPerDay` per chain per day, two caps around midnight, only into listed project wallets. Cap-use and rate alerts (TRS-18). The owners remove the key. Its own wallet's float is lost, as today. |
| Only refiller drained by ordinary work | TRS-16 `refillReserve`: the `Relayer` refuses non-refill sends below it. |
| Watchdog key stolen | Pauses accounts on listed policies; no money moves. It can re-pause after each unpause until the owners remove it from `watchdogs`, which is one owner transaction. Separate from relayers (TRS-32). |
| Module bug | Module code is small and fork-tested (T1): unlisted wallet, over cap, non-refiller, `pause` on an unlisted policy, and any path to a delegatecall are each refused; a wallet at or above `low` is a no-op, never a revert. The owners can disable the module. |
| Owner key lost | 2 of 3: one loss is recoverable. |
| Owners rotated after a compromise | TRS-03: new chains get a new address, and the old address is hostile where undeployed. |
| Treasury runs dry | Refills revert; the TRS-18 floor alert fires first. |
| Refill reported but not sent | TRS-12 reverts on inner failure; TRS-17 checks the balance delta. |
| Two operators refill at once | One refiller per chain (TRS-16), and the amount is computed on chain (TRS-12): a second call sends nothing. |
| Linking Ot to the treasury | TRS-04, with its stated limit. |
| Policy deployed with a treasury guardian that does not exist on that chain | TRS-30 refuses the deploy. |

## Out of scope

- Refilling per-account Safe gas reserves (`docs/gas-reserve.md`). Recipients are users' accounts, so this is
  sponsorship, not treasury. It stays the relayer's job, within `sponsorship.ts` limits, in its own ticket.
- Moving money between chains automatically. The treasury holds a balance per chain, and Ot tops up the chain that
  TRS-18 names.
- Paymaster deposits. Mamoru funds none: the Ethereum bridge-out uses Pimlico's ERC-20 paymaster.

## Tasks

Each task names its requirements and what accepts it. None runs against a live chain without the coordinator.

- **T0 (Ot, now, manual)** Fund guardian `0xA8E6…1FdD` once, from the fresh source of TRS-04: 0.0005 ETH on Base and
  1 MON on Monad. Answer TRS-33's question. This restores the brake on live policies. Accepted by a balance read.
- **T1** `contracts/treasury/`: `MamoruTreasuryModule.sol` and a Foundry script.
  - The script predicts the treasury address and checks factory and singleton code hashes.
  - Fork tests on Base and Monad, for TRS-12, 13 and 15:
    - refill of a listed wallet under `low` reaches `target`;
    - an unlisted wallet, over the cap, and a non-refiller caller are each refused;
    - a wallet at or above `low`, including a second refill in the same block, is a no-op: no transfer, no event, no
      revert;
    - a self-refill sent with the TRS-16 shape at its ceiling overshoots `target` by at most `refillReserve` and stays
      within the cap;
    - an inner send failure reverts;
    - `pause` by a watchdog on a listed V3 fork policy pauses it;
    - `pause` on an unlisted policy, or by a refiller, is refused;
    - no path makes a delegatecall.
  - Security review before merge. Must not deploy anything live.
- **T2** `packages/registry`: a `treasury` entry per chain and the TRS-14 table, exported for the operator and the
  landing. TRS-03, 14.
- **T3** `apps/mamoru-operator/src/treasury-refill.ts`: the TRS-17 loop behind `MAMORU_TREASURY_REFILL` (default off,
  prod only), with the TRS-18 alerts and the TRS-20 rows, and the `refillReserve` guard in `Relayer` (TRS-16). `/metrics` gets `treasury.balanceWei`, `refills[]` and
  `capLeftWei`. Lab scenario on a fork:
  - a wallet below `low` is refilled once;
  - a second tick in flight sends nothing;
  - a module revert is recorded and posted once.
- **T4** Live setup, coordinator only, after TRS-05 is answered:
  - create the treasury on Base, Ethereum and Monad;
  - deploy and enable the module, and write the TRS-14 table, refillers and caps;
  - run the TRS-19 Monad check;
  - measure 14 days of burn per wallet and set TRS-14 / TRS-15 from it;
  - fund each chain with two days of `capPerDay`;
  - turn on T3.
- **T5** mamoru-landing /ops Money → Funding per TRS-40–42, in its own ticket in otto/mamoru-astro.
- **T6** Guardian, blocked on TRS-34. Deploy scripts take `GUARDIAN` from the registry's treasury and run the TRS-30
  checks. The release adds the policy to the module's `policies`. A test fails if a deploy script names an EOA
  guardian for a policy not pinned before this spec.
- **T7** Watchdog: its own key and process, with the conditions that trigger a pause, in its own spec. Until then
  TRS-32 applies.

## Scenarios

| Id | Given | When | Then | Req |
|---|---|---|---|---|
| TRS-S1 | Base relayer under `low`, cap unused | review tick | `refill` emits `Refilled`; the relayer ends at `target`, give or take the call's fee and the overshoot (TRS-12); row written | TRS-12, 17, 20 |
| TRS-S2 | refill in flight, or a second operator | another `refill` for the same wallet | no-op, recorded as "already at target" | TRS-12, 16 |
| TRS-S3 | cap spent today | wallet under `low` | revert recorded, one `#mamoru-ops` post that day | TRS-15, 18 |
| TRS-S4 | refiller | `refill` of an unlisted wallet | reverts | TRS-12 |
| TRS-S5 | watchdog | `pause(policy, a)` on a listed policy whose guardian is the treasury | `a` is paused | TRS-13 |
| TRS-S6 | watchdog | `pause` on an unlisted policy | reverts | TRS-13 |
| TRS-S7 | owners sign `pause(a)` | the legacy guardian EOA submits it | `a` is paused | TRS-31 |
| TRS-S8 | treasury on a chain under `capPerDay` | daily check, no refill history | one post naming chain, address and amount | TRS-18 |
| TRS-S9 | `capPerDay` used past 80% | the refill that crosses it | cap-use post | TRS-18 |
| TRS-S10 | relayer at `refillReserve` + a little | a non-refill send that would cross it | `Relayer` refuses it; the next `refill` still pays | TRS-16 |
