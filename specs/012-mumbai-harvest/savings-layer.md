# 012 addendum: harvested yield becomes savings in the Stable vault

Ticket: otto/mamoru#413. Owner decision, 22 Nov 2026. Replaces HRV-R3 for **harvested** USDC only; HRV-R3 still places
free bucket money. Related: #433 (fee on vault growth), #380 (Portfolio shows savings), #428 (Monad exit).

## Rule

- **SAV-R1. Harvested USDC is savings.** The USDC side of a harvest's collected fees, plus the USDC a harvest sale
  (HRV-R1) returned, is `pending` savings. Pending savings are not free money: no entry, swap, bridge or HRV-R3 sweep
  spends them. They wait in the Safe until a **savings deposit** puts them into the Stable bucket's vault.
- **SAV-R2. Savings deposit.** A `vault_deposit` with `savings: true` of `min(pending, maxDeposit, vaultRoom)`, only
  when that is at least the vault floor (`max(vaultMinDeposit, entry floor)`, the same as allocate's), the V4 room
  reserve holds after it (HRV-R7, `reinvestFits`) and the V4 vault ratio leaves room. Less waits and adds up with the
  next harvests. Order in a review: re-range, harvest, harvest sale, savings deposit, reduce, idle sale, entries.
  Never while the stables bucket is frozen, a vault the policy names is unread, or a deposit is unsafe.
- **SAV-R3. Two books on one vault.** The vault's shares are split into `savings` and `bucket`
  (`bucket = held - savings`). Savings shares come only from savings deposits (their `Deposit` receipt facts) and
  have their own basis (assets at entry; the 10 % fee was paid when they were collected, so #433 charges only their
  growth). They never exceed the shares held.
- **SAV-R4. Targets on bucket principal only.** Allocation, the drain band (`reduceOf`) and the redeem check see the
  account without its savings: pending savings are taken off the free USDC and savings shares off the vault.
  Targets (v8: 50/25/25) are computed on that. The drain band can redeem bucket shares only, never savings. The cap
  (#353) still counts savings as placed (conservative: savings never add room for new money).
- **SAV-R5. Withdrawals take savings first.** A withdrawal of `W` (amount plus fee) lowers pending savings first,
  then savings shares (at the vault rate read at prepare), then nothing more of the books: the rest is bucket money.
  What the Safe physically pays from is unchanged (idle USDC, then the vault, then positions): the shares are the same
  shares, only their tag moves. The split is computed at prepare and stored on the op; applied when it confirms,
  never above what the books hold then. A Stop empties the books.
- **SAV-R6. Monad.** No savings vault on Monad (being exited, #428). Monad harvests stay free USDC there and return to
  Base by HRV-R4 like any idle USDC; they are not tagged savings on arrival.

## Books (operator)

Derived at every review from the account's stored ops (as `harvested.ts` does), not kept as a counter:

- ops stored by this code carry `savingsIn` (a harvest, or a harvest sale) and `savings` (a savings deposit);
  older ops are never counted, so there is no backfill and no start date;
- `pending += ` USDC fees of a `savingsIn` harvest, `+=` the sale's net USDC in (`facts.usdcIn`, new, additive);
  `-= ` assets of each savings deposit;
- `shares[vault] += ` the deposit's minted shares, `basis += ` its assets; a deposit whose receipt is not read yet is
  counted at the vault rate of the review (so the drain band never sees it as bucket money);
- a confirmed withdrawal subtracts its stored `savingsOut`; a confirmed Stop resets the books (new epoch);
- clamps: `pending ≤ USDC held`, `shares ≤ shares held`; what a clamp takes is stored per epoch (like
  `harvestedCut`) so a later deposit never re-tags as savings. A clamp lowers basis pro rata.

Savings + bucket is always the account: the books are a partition of balances already counted, never an addition.

## Contract for the app and the fee

`AccountSavings` in `packages/domain/src/savings.ts` (raw USDC, decimal strings): `usdc` (pending + savings shares at
the vault rate), `basisUsdc`, `pendingUsdc`, `vaults[] { vault, shares, usdc, basisUsdc }`, `status`
(`counted` | `partial`: a receipt not read yet). Served per Safe on the Base snapshot (`SafeSnapshot.savings`) and
stored by the Worker (`account_savings`, one row per account and UTC day). Earned (spec 012, one definition) already
counts the collected fees and the vault yield of every share, savings included: `usdc` is shown beside it (the "earned"
line next to the Stable row) and is never added to earned a second time. The account total includes it once, as it
already does (it is part of the vault and idle values).

## Scenarios

- SAV-S1 harvest of WETH/USDC fees → sale → pending → savings deposit once ≥ floor; pools untouched.
- SAV-S2 pending below the floor waits, adds up over harvests, then one deposit.
- SAV-S3 V4 room short (HRV-R7) or vault ratio full: pending waits with `DECIDE_WAIT_BUDGET`.
- SAV-S4 targets with 100 of savings in the vault equal the targets without it; the drain band does not redeem them.
- SAV-S5 withdrawal smaller than savings: savings drop by W, bucket unchanged; larger: savings 0, bucket pays the rest.
- SAV-S6 Stop: books empty; a later Start does not re-tag anything.
- SAV-S7 savings + bucket = vault shares held, after any sequence of deposits, redeems and withdrawals (no double count).

## Out of scope

The app's display (#380), the fee on vault growth (#433), the Lab comparison of harvest modes (still running, only
for thresholds), re-range-collected fees (they stay in the re-mint, as today).
