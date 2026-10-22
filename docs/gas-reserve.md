# Gas reserve at activation

The engine pays its user operations with native ETH held in the account's Safe (no paymaster, FR-ACC-002). A
Safe starts with `policy.gasReserveWei + TOP_UP_MARGIN_WEI` of it: 0.0003 + 0.0002 = **0.0005 ETH** on the live
policies, about 1.35 USD at 2,700 USD/ETH. This page says who pays it.

## Who pays what

| Cost | Paid by | Gone after the start? |
|---|---|---|
| Safe deploy and the activation `execTransaction` | relayer, reserved against `activationWeiPerDay` (`sponsorship.ts`) | yes, spent on chain |
| The reserve, 0.0005 ETH, left in the Safe | the Safe itself when it can (below), else the relayer's top-up, reserved against the same `activationWeiPerDay` | no, it stays the owner's |

Before anything is sent, `executeOwner` reserves the relayer's spend on the activation against the daily activation
budget across all accounts (`chargeActivation`): the deploy (an undeployed Safe), the exec gas, and the top-up the
Safe still lacks. A self-funded activation counts the swap's minimum out as held, so it reserves only the deploy and
exec gas, and the relayer sends no top-up. Over the budget, an activation is refused (`SPONSOR_DAILY_BUDGET`) before
anything is sent.

## The Safe buys its own reserve (otto/mamoru#15)

`prepareActivate` adds a USDC -> ETH swap to the batch the owner signs, after the grants are enabled:
`approve(USDC, SwapRouter02, amountIn)`, `SwapRouter02.multicall(deadline, [exactInputSingle(USDC -> WETH),
unwrapWETH9(minOut, Safe)])`, `approve(USDC, SwapRouter02, 0)` (`gasReserveCalls`, `packages/account/live`).
No grant, session permission or policy changes: it is an owner call like the ones of a withdrawal to ETH. It rides
in the v2/v3 activation (`fitActivation`) and in the first transaction of a v4 one (`fitV4`), with its gas counted.

| | Value | Where |
|---|---|---|
| Minimum out | the reserve the Safe lacks (`target - eth`), so 0.0005 ETH for a new Safe | `selfReservePlan` |
| Reference price | the 30-minute TWAP of the pool the spot quote chose (`observe([1800, 0])`; best of WETH/USDC 0.05% and 0.30%) | `twapTickAt`, `usdcForWeiAtTick` |
| USDC in | the TWAP cost of the missing reserve + 1% + the pool fee, never more: **1.364039 USDC** at 2,700 USD/ETH on the 0.05% pool | `selfReservePlan` |
| Spot check | the QuoterV2 spot for 1 USDC must not make the reserve dearer than that, i.e. more than 1% (~100 ticks) over the TWAP | `TWAP_DIVERGENCE` |
| Exact-amount check | the quote for exactly that USDC must give at least the minimum | `selfReserveConfirmed` |
| Smallest account | 10 USDC | `SELF_RESERVE_MIN_USDC` |
| Largest conversion | 3 USDC (0.0005 ETH stays under it up to ~5,900 USD/ETH) | `SELF_RESERVE_MAX_USDC` |
| Swap deadline | 1 hour after the prepare block; nothing is reserved, simulated or sent within 10 minutes of it | `SELF_RESERVE_DEADLINE_SECONDS`, `reserveExpired` |

The swap either pays at least the minimum into the Safe or reverts, and the whole activation with it (`safeTxGas`
0: GS013). The preflight simulates the full `execTransaction` before the relayer sends anything. What the owner can
lose to the price or to MEV is bounded against the TWAP, not the spot: 1% plus the pool fee of the reserve's fair
cost (about 0.014 USD); any ETH above the minimum is theirs in the Safe. If ETH rises more than ~1% between the
prepare and the send, the preflight refuses the start and the owner prepares again. The activation summary says it,
to the unit: "Convert 1.364039 USDC to at least 0.0005 ETH on Uniswap v3 USDC/WETH 0.05% + unwrap, kept in your Safe
as its gas reserve", and the USDC it then invests is shown net of it.

## The deadline

- An armed approval never sent, within 10 minutes of the deadline, is dropped with `RESERVE_SWAP_EXPIRED`; the app
  shows "Start needs another approval", as for any failed start.
- `executeOwner` checks the deadline against the later of the wall clock and the provider's head twice: before
  anything is reserved, and again right before the `execTransaction` leaves (after the deploy and the simulation).
  Past it, nothing more is sent: `RESERVE_SWAP_EXPIRED`, or, when an earlier attempt may already have handed a copy to
  a provider, an unread receipt (`OWNER_TX_ERROR`) that the chain settles.
- A sent activation is settled as every activation is since otto/mamoru#163 (`settleByNonce`): a revert is never
  final while its Safe nonce is unspent, since anyone can relay the owner's signature. The swap's deadline adds one
  proof: at a block `SETTLE_CONFIRMATIONS` below the head, still canonical, whose own timestamp is past the deadline,
  the Safe nonce still the SafeTx's. Up to that block it did not run, and from it on SwapRouter02 refuses the swap
  ("Transaction too old") and with it the whole `execTransaction`. It is closed as `RESERVE_SWAP_EXPIRED` and the owner
  starts again as usual. Short of that proof (a read fails, the block not past the deadline yet) it stays open.

## When the relayer still pays

The batch has no swap, and the relayer tops the reserve up (within `activationWeiPerDay`), when:

- nothing was deposited when the owner signed (the approval is armed before the deposit): a swap signed for an
  amount that is not there yet would revert;
- the Safe holds less than 10 USDC;
- there is no quote, the pool cannot answer `observe` for the 30-minute window, the spot is more than 1% dearer than
  the TWAP, the quote for the exact amount is short, or the reserve would cost more than 3 USDC;
- the Safe already holds its reserve (nothing to buy, nothing to pay).

## Bootstrapping the first gas

The relayer sends the deploy and the `execTransaction`; the Safe has no ETH of its own before that transaction.
The swap runs inside it, so when it lands the reserve is in the Safe and the engine's first user operation pays
its own prefund. A self-funded activation only needs the relayer to hold `ACTIVATION_GAS_WEI` (0.0002 ETH), not
reserve + margin + gas (0.0007 ETH); a signed approval that has to wait for the relayer keeps its swap
(`armed.reserveWei`) and still sends no top-up when it runs. Refunding that gas from the Safe through the Safe's own
`gasPrice`/`refundReceiver` was left out on purpose: with `gasPrice > 0` a failed inner call no longer reverts the
`execTransaction`, so a broken activation would still pay.
