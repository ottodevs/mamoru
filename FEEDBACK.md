# Uniswap developer feedback

ETHGlobal Tokyo 2026. Project: Mamoru. Repository: https://github.com/ottodevs/mamoru, branch `main`.

Mamoru v1 is a non-custodial savings account on Base. In production it runs in simulation mode: it plans and simulates, and it does not sign or send transactions. Every Uniswap call below is either encoded and checked in unit tests, or executed on a local Anvil fork of Base pinned at block 51811000 with chain id 31337. Nothing here touched Base mainnet with funds.

## What we used

| Piece | Where | What it does |
|---|---|---|
| Uniswap v3 addresses on Base | [`packages/registry/base.json`](packages/registry/base.json) | UniswapV3Factory, NonfungiblePositionManager, SwapRouter02, QuoterV2, the USDC/cbBTC 0.05% pool and the WETH/USDC 0.3% pool, each with the code hash we checked at block 51811000 ([`scenarios/manifest.json`](scenarios/manifest.json)) |
| Call builders | [`packages/uniswap-v3/src/index.ts`](packages/uniswap-v3/src/index.ts) | `approve` (L18), `exactInputSingle` on SwapRouter02 (L24), `mint` on the NonfungiblePositionManager (L54), `decreaseLiquidity` (L98), `collect` (L107), `burn` (L118) |
| Session limits around those calls | [`packages/account/sessions/index.ts`](packages/account/sessions/index.ts) (`toSmartSession`, L103) and [`packages/policy/src/grants.ts`](packages/policy/src/grants.ts) | A Rhinestone Smart Session on a Safe (ERC-7579) that may only call the selectors above on the registry addresses, with argument rules: recipient is the account, minimums are positive, a position can be managed only after the account minted it in the same batch that records its token id |
| Fork checks | [`scenarios/catalog/`](scenarios/catalog/), runner in [`packages/scenarios/runner/`](packages/scenarios/runner/) | SESS-01 to SESS-23 and SESS-25 treat the session key as leaked and try to swap to an attacker, mint to an attacker, approve max, collect someone else's position and so on. Each attack must be rejected by the chain |
| Quotes and harvest | `packages/uniswap-v3` quote part and `packages/decide/harvest` | [PENDING L1] QuoterV2 quotes and the T003 harvest on the fork |
| Pool reads for the dashboard | `apps/mamoru-engine/src/sync/pool-state.ts` | [PENDING L4] `slot0`, liquidity and Swap/Mint/Burn logs of the USDC/cbBTC 0.05% pool read from Base |

## What was clear

- The v3 periphery signatures are stable. Once the ABIs were pinned, encoding the calls with viem was direct.
- `exactInputSingle` on SwapRouter02 takes the recipient in the params struct, so we can force it to be the account.
- Mint takes ticks that must sit on the pool's tick spacing. The builder checks that before encoding.

## What we read twice

- How loose a minimum is allowed to be. Our builders reject a non-positive `amountOutMinimum` and non-positive mint minimums, so a session can never sign a call with no floor. A zero minimum is legal on chain, which is the reason a leaked key is dangerous.
- SwapRouter02 has no `deadline` in `exactInputSingle` (unlike the original SwapRouter). The deadline lives on the position manager calls only. We found this by comparing ABIs, not from one page.
- `sqrtPriceLimitX96` stays zero in our swaps. The docs explain what it does, but not clearly that zero means "no limit" for a single-hop swap with a minimum output.

## What would have saved time

- One page per chain that lists SwapRouter02, QuoterV2 and the NonfungiblePositionManager addresses on Base next to the exact ABI version that is deployed there. We pinned the addresses and checked the code hashes ourselves.
- A short note on which periphery contracts differ between chains (SwapRouter vs SwapRouter02, deadline placement).
- An example of a session-key or policy setup that limits a delegated signer to Uniswap selectors with argument checks. Agentic and automated accounts need this, and today every team writes it from scratch.

## What did not work or is not done

- We did not use v4 or the Uniswap API. v1 is v3 only, by design: one pool that we could verify on Base at a fixed block.
- The harvest path (collect, swap to USDC, re-add) on the fork is [PENDING L1] at the time of writing.
