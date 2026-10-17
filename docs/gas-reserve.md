# Gas reserve at activation

The engine pays its user operations with native ETH held in the account's Safe (no paymaster, FR-ACC-002). A
Safe starts with `policy.gasReserveWei + TOP_UP_MARGIN_WEI` of it: 0.0003 + 0.0002 = **0.0005 ETH** on the live
policies, about 1.35 USD at 2,700 USD/ETH. This page says who pays it.

## Who pays what

| Cost | Paid by | Gone after the start? |
|---|---|---|
| Safe deploy and the activation `execTransaction` (~14M gas; `ACTIVATION_GAS_WEI` = 0.0002 ETH is budgeted) | relayer | yes, spent on chain |
| The reserve, 0.0005 ETH, left in the Safe | the Safe itself when it can (below), else the relayer within #82's limits | no, it stays the owner's |

## The Safe buys its own reserve (otto/mamoru#15)

`prepareActivate` adds a USDC -> ETH swap to the batch the owner signs, after the grants are enabled:
`approve(USDC, SwapRouter02, amountIn)`, `SwapRouter02.multicall(deadline, [exactInputSingle(USDC -> WETH),
unwrapWETH9(minOut, Safe)])`, `approve(USDC, SwapRouter02, 0)` (`gasReserveCalls`, `packages/account/live`).
No grant, session permission or policy changes: it is an owner call like the ones of a withdrawal to ETH.

| | Value | Where |
|---|---|---|
| Minimum out | the reserve the Safe lacks (`target - eth`), so 0.0005 ETH for a new Safe | `selfReservePlan` |
| Reference price | the 30-minute TWAP of the pool the spot quote chose (`observe([1800, 0])`; best of WETH/USDC 0.05% and 0.30%) | `meanTick`, `usdcForWeiAtTick` |
| USDC in | the TWAP cost of the missing reserve + 1% + the pool fee, never more: **1.364039 USDC** at 2,700 USD/ETH on the 0.05% pool | `selfReservePlan` |
| Spot check | the QuoterV2 spot for 1 USDC must not make the reserve dearer than that, i.e. more than 1% (~100 ticks, `maxTwapDeviationTicks`) over the TWAP | `TWAP_DIVERGENCE` |
| Exact-amount check | the quote for exactly that USDC must give at least the minimum | `selfReserveConfirmed` |
| Smallest account | 10 USDC (same as the subsidy minimum) | `SELF_RESERVE_MIN_USDC` |
| Largest conversion | 3 USDC (0.0005 ETH stays under it up to ~5,900 USD/ETH) | `SELF_RESERVE_MAX_USDC` |
| Swap deadline | 7 days after the prepare block; nothing is simulated or sent within 10 minutes of it | `SELF_RESERVE_DEADLINE_SECONDS`, `reserveExpired` |

The swap either pays at least the minimum into the Safe or reverts, and the whole activation with it. The
preflight simulates the full `execTransaction` before the relayer sends anything, so a swap that would come short
costs the relayer nothing and the owner prepares again. What the owner can lose to the price or to MEV is bounded
against the TWAP, not the spot: 1% plus the pool fee of the reserve's fair cost (about 0.014 USD), whatever the spot
says at the prepare; any ETH above the minimum is theirs in the Safe. The other side of that bound: if ETH rises
more than ~1% between the prepare and the send, the preflight refuses the start and the owner prepares again. The
activation summary says it, to the unit: "Convert 1.364039 USDC to at least 0.0005 ETH on Uniswap v3 USDC/WETH
0.05% + unwrap, kept in your Safe as its gas reserve", and the USDC it then invests is shown net of it.

An armed approval has no lifetime of its own, so the swap deadline is its bound: one still waiting (for the relayer)
within 10 minutes of the deadline is dropped with `RESERVE_SWAP_EXPIRED` and the app asks for a new approval, as for
any failed start. One whose `execTransaction` was already handed to a provider is not sent again; reconciliation
reads whether it landed. The limit also travels with the send itself (`notAfter` on the relayer job, deadline minus
10 minutes): the relayer checks it again after its queue and its reads, right before the broadcast, against the later
of its clock (read after the head) and the chain head, and drops the job (`SendExpired`, `RESERVE_SWAP_EXPIRED`)
instead of sending it, on every attempt. The limit also goes to the local RPC proxy in the `x-mamoru-not-after`
header, which only the proxy reads (upstream requests never carry it): past it the proxy hands the signed transaction
to no further provider, first try or fallback, and says so in its own `x-mamoru-send-verdict` response header
(`not-sent` or `maybe-sent`). No provider's header or error code can stand for it. Only `not-sent` fails the start
as `RESERVE_SWAP_EXPIRED`. Any other failure after the hand-over may be out.

What may be out is settled only by chain evidence, never by a copy not found. The relayer gives the hash and nonce of
each signed copy before it leaves; they are kept on the op (`signedTxs`) with the SafeTx's hash and Safe nonce.
Reconciliation then decides as follows:

- **A success receipt.** Every copy's receipt is read, and a success that executed the SafeTx wins: the account starts.
- **A reverted copy.** It proves nothing alone, because another copy, or anyone relaying the calldata, may have
  executed the SafeTx first. If the Safe nonce at the revert's block is still the SafeTx's, the start failed
  (`OWNER_TX_FAILED`, gas paid). If the nonce moved, the Safe's `ExecutionSuccess(safeTxHash)` settles it as
  confirmed, and its absence as `SAFE_NONCE_MOVED`.
- **No receipt, swap deadline passed.** This is read at a block whose own timestamp is past the deadline. If the Safe
  nonce is still the SafeTx's, the start never ran and never can (the router refuses after the deadline):
  `RESERVE_SWAP_EXPIRED`, and the owner may start again. If the nonce moved, it is confirmed or `SAFE_NONCE_MOVED`, as
  above.
- **Anything that cannot be read** leaves the op open.

While an op is open, reconciliation runs again on its own timer, with no app traffic needed: after 10 s, doubling up to
5 minutes. The timer is armed wherever the op is saved in that state, and again at startup.

From the first unknown receipt, the activation is shown in `GET /ops` as `confirming`. The app says "We're confirming
your start…" and offers no new approval. The operator refuses a new activate prepare or submit for that account
(`START_CONFIRMING`), so an old app or a direct call cannot start it twice.

An op still open 3 timer passes after its window (swap deadline + 10 minutes) is marked `needsReview` (saved, logged
once as an `[alert]`); other passes do not count. The timer then leaves it alone. It is listed in `GET /metrics` as
`operator.ownerOpsNeedingReview` (count, Safe and op id) and in `GET /ops`. The startup pass and every `GET /ops` pass
keep reading it, so it settles itself once the chain answers. Settled either way, it leaves the list and the
confirming state.

### Settling a needsReview op by hand

This only happens when the chain could not be read for long: the receipts, the Safe nonce at a block, or the Safe's
logs. There is no admin action for it yet (follow-up ticket).

1. Take the op's `signedTxs` hashes from `GET /ops` (or `accounts.json`) and look them up on Basescan, together with
   the Safe's transactions after the time of the first one.
2. Once the operator's provider answers again, restart the operator or wait for the next `GET /ops`. The rules above
   settle it on their own. Do not mark a start confirmed by hand: only the settlement path starts the engine with the
   op's grants.
3. Only if Basescan shows the Safe nonce still at the SafeTx's past the deadline, and the provider still cannot be
   read, the coordinator closes it by hand. Stop the operator (it has one owner, see `AGENTS.md`). In the operator's
   `accounts.json`, set the op's `code` to `RESERVE_SWAP_EXPIRED` and remove `needsReview`. Start the operator again.
   The owner is then offered a new Start.

## When the relayer still pays (#82)

The batch has no swap, and the relayer's top-up is decided by `subsidy.ts` exactly as before, when:

- nothing was deposited when the owner signed (the approval is armed before the deposit): a swap signed for an
  amount that is not there yet would revert;
- the Safe holds less than 10 USDC (then #82 refuses too: the owner sends 0.0005 ETH);
- there is no quote, the pool cannot answer `observe` for the 30-minute window, the spot is more than 1% dearer than
  the TWAP, the quote for the exact amount is short, or the reserve would cost more than 3 USDC;
- the Safe already holds its reserve (nothing to buy, nothing to pay).

#82's limits: 10 USDC in the Safe, 2 reserves per Safe, 3 per passkey, `MAMORU_SUBSIDY_PER_DAY` (default 10)
across all accounts in 24 hours, forfeited by an exit within 72 hours of a paid reserve.

## Bootstrapping the first gas

The relayer sends the deploy and the `execTransaction`; the Safe has no ETH of its own before that transaction.
The swap runs inside it, so when it lands the reserve is in the Safe and the engine's first user operation pays
its own prefund. A self-funded activation only needs the relayer to hold `ACTIVATION_GAS_WEI` (0.0002 ETH), not
reserve + margin + gas (0.0007 ETH); a signed approval that has to wait for the relayer keeps its swap
(`armed.reserveWei`) and still sends no top-up when it runs. Refunding that gas from the Safe through the Safe's own
`gasPrice`/`refundReceiver` was left out on purpose: with `gasPrice > 0` a failed inner call no longer reverts the
`execTransaction`, so a broken activation would still pay.
