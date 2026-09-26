# Uniswap developer feedback

ETHGlobal Tokyo 2026. Project: Mamoru. Branch: `spec/mamoru-v1`.

The capital calls are in `packages/uniswap-v3/src/index.ts`. They encode Uniswap v3 on Base: `SwapRouter02.exactInputSingle`, and `NonfungiblePositionManager` mint, decreaseLiquidity, collect, and burn. Addresses and ABIs are pinned in `packages/registry/base.json` at Base block 51811000.

What was clear: the v3 periphery signatures are stable. Once the ABIs were pinned, encoding the calls with viem was direct. `exactInputSingle` takes the account as recipient. Mint takes ticks on the pool spacing.

What we read twice: how loose a minimum is allowed to be. Our builders reject a non-positive `amountOutMinimum` and non-positive mint minimums, so a session cannot sign a call with no floor. Deadline has to be set. `sqrtPriceLimitX96` stays zero.

What would have saved time: one page that lists the Base addresses for SwapRouter02 and the Nonfungible Position Manager next to the canonical ABIs, with a note on deadline and `sqrtPriceLimitX96`. We pinned those in the registry ourselves.

The session that is allowed to sign these calls is encoded in `packages/account/sessions/index.ts`. The fork checks live in `packages/scenarios`.
