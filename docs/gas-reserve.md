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
reads whether it landed.

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
