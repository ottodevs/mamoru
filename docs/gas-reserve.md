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
| USDC in | the QuoterV2 rate for 1 USDC (best of WETH/USDC 0.05% and 0.30%), + 10% headroom, rounded up to a cent: **1.49 USDC** at 2,700 USD/ETH | `selfReserveAmountIn` |
| Exact-amount check | the quote for exactly that USDC must clear the minimum by 5%, or there is no swap | `selfReserveConfirmed` |
| Smallest account | 10 USDC (same as the subsidy minimum) | `SELF_RESERVE_MIN_USDC` |
| Largest conversion | 3 USDC (0.0005 ETH stays under it up to ~5,400 USD/ETH) | `SELF_RESERVE_MAX_USDC` |
| Swap deadline | 7 days after the prepare block | `SELF_RESERVE_DEADLINE_SECONDS` |

The swap either pays at least the minimum into the Safe or reverts, and the whole activation with it. The
preflight simulates the full `execTransaction` before the relayer sends anything, so a swap that would come short
costs the relayer nothing and the owner prepares again. What the owner can lose to the price or to MEV is bounded
by the headroom (about 0.14 USD) and by the 3 USDC cap; any ETH above the minimum is theirs in the Safe. The
activation summary says it: "Convert 1.49 USDC to at least 0.0005 ETH on Uniswap v3 USDC/WETH 0.05% + unwrap, kept in
your Safe as its gas reserve", and the USDC it then invests is shown net of it.

The rate is the QuoterV2 spot at the prepare block. TODO (#140): size it from the pool TWAP floor once #46/#64 land.

## When the relayer still pays (#82)

The batch has no swap, and the relayer's top-up is decided by `subsidy.ts` exactly as before, when:

- nothing was deposited when the owner signed (the approval is armed before the deposit): a swap signed for an
  amount that is not there yet would revert;
- the Safe holds less than 10 USDC (then #82 refuses too: the owner sends 0.0005 ETH);
- there is no quote, the quote for the exact amount is short, or the reserve would cost more than 3 USDC;
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
