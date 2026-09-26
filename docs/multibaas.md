# MultiBaas in Mamoru

Annex to the README sections "How MultiBaas was used" and "Experience with MultiBaas". The design is in [`specs/001-mamoru-v1/dashboard.md`](../specs/001-mamoru-v1/dashboard.md) §6. Evidence lives in [`evidence/multibaas/`](../evidence/multibaas/).

## Role

MultiBaas is the indexer behind the production dashboard on Base (chain id 8453). Only the engine Worker calls it, with a read-only key. The browser never calls it. By design (dashboard.md §6.5), every row the engine takes from MultiBaas is checked against Base RPC (`eth_getLogs` with the same filter and range) before it is stored in D1; which queries do this in the deployed engine is [PENDING L4]. The app API serves the dashboard only from D1, and each figure carries its source and chain id.

MultiBaas does not sign, send or relay anything for Mamoru, and it does not decide anything. It does not index the Base fork used for verification.

## Linked contracts

See [`evidence/multibaas/mb-01-deployment.md`](../evidence/multibaas/mb-01-deployment.md): the USDC/cbBTC 0.05% pool, the NonfungiblePositionManager and EntryPoint v0.7, with the canonical ABIs.

## Queries

| Id | Contract | Event | View | Reconciled against RPC |
|---|---|---|---|---|
| MBQ-01 | Pool | `Swap` | Pools in your plan | [PENDING L4] |
| MBQ-02 | Pool | `Mint`, `Burn` | Pools in your plan | [PENDING L4] |
| MBQ-03 | NonfungiblePositionManager | `IncreaseLiquidity`, `DecreaseLiquidity`, `Collect` by `tokenId` | Your positions | [PENDING L4] |
| MBQ-04 | NonfungiblePositionManager | `Transfer` from or to the account | Your positions | [PENDING L4] |
| MBQ-05 | EntryPoint v0.7 | `UserOperationEvent`, `UserOperationRevertReason` by sender | Current Action | [PENDING L4] |
| MBQ-06 | Linked contracts | events of one transaction | Savings Log | [PENDING L4] |
| MBQ-07 | Pool | `Swap` aggregates (min and max tick, volume) | Pools in your plan | [PENDING L4] |
| MBQ-08 | Pool | `Swap` with the account as recipient | Treasury | [PENDING L4] |

Query builders: `packages/multibaas/src/queries.ts` [PENDING L4 merge]. Client: `packages/multibaas/src/client.ts` [PENDING L4 merge].

## Fallback

If MultiBaas is behind, failing, not configured, or a range is older than the contract's start block, the engine reads Base RPC logs for that range and labels every row with the cause (dashboard.md §6.6). The Free plan's 100-block depth limit makes `MB_BEFORE_START_BLOCK` the normal case for history older than the link.

## Webhooks

Not used. No webhook was created on the deployment.
