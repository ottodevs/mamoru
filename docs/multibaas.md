# MultiBaas in Mamoru

Annex to the README sections "How MultiBaas was used" and "Experience with MultiBaas". The design is in [`specs/001-mamoru-v1/dashboard.md`](../specs/001-mamoru-v1/dashboard.md) §6. Evidence: [`evidence/multibaas/mb-01-deployment.md`](../evidence/multibaas/mb-01-deployment.md) and [`evidence/multibaas/mb-02-04-results.md`](../evidence/multibaas/mb-02-04-results.md).

## Role

MultiBaas is one of two sources for the history the dashboard shows on Base (chain id 8453). Only the engine Worker (`apps/mamoru-engine`, a cron every 2 minutes) calls it, with a read-only key. The browser never calls it. The engine matches every MultiBaas row against Base `eth_getLogs` with the same filter and range before it stores the row in D1. The app API serves the dashboard only from D1, and each figure carries its source and chain id.

MultiBaas does not sign, send or relay anything for Mamoru, and it does not decide anything. It does not index the Base fork used for verification.

## What the engine reads

| Data | Source |
|---|---|
| Pool `slot0`, liquidity, token balances, TWAP (1800 s window, 100-tick guard) | Base RPC at the `safe` block |
| Account code and balances | Base RPC at the `safe` block |
| Pool `Swap`, `Mint`, `Burn` over the last hour | MultiBaas rows reconciled against Base RPC logs after the index start block; Base RPC logs before it, labeled "before MultiBaas start" |

## Linked contracts

The USDC/cbBTC 0.05% pool (the one pool in the Conservador plan), the NonfungiblePositionManager and EntryPoint v0.7, with canonical ABIs. Details in [`mb-01-deployment.md`](../evidence/multibaas/mb-01-deployment.md).

## Queries

| Id | Contract | Event | Used as a source | Result |
|---|---|---|---|---|
| MBQ-01 | Pool | `Swap` | yes | reconciled: probe 10 of 10, 0 RPC-only, 0 MultiBaas-only after the start block |
| MBQ-02 | Pool | `Mint`, `Burn` | yes, in the same call as MBQ-01 | reconciled with MBQ-01 |
| MBQ-03 | NonfungiblePositionManager | position events by `tokenId` | no | built; no account has positions in simulation mode |
| MBQ-04 | NonfungiblePositionManager | `Transfer` from or to the account | no | built; nothing to read yet |
| MBQ-05 | EntryPoint v0.7 | `UserOperationEvent`, `UserOperationRevertReason` | no | built; no userOps are sent in simulation mode |
| MBQ-06 | Linked contracts | events of one transaction | no | returned empty for a pool `Swap` transaction |
| MBQ-07 | Pool | `Swap` aggregates | no, never | unreliable: tick min and max compared as strings, a `greaterthan` filter ignored |
| MBQ-08 | Pool | `Swap` with the account as recipient | no | built; nothing to read yet |

Builders: [`packages/multibaas/src/queries.ts`](../packages/multibaas/src/queries.ts). Client: [`packages/multibaas/src/client.ts`](../packages/multibaas/src/client.ts). Reconciliation: [`apps/mamoru-engine/src/sync/multibaas-index.ts`](../apps/mamoru-engine/src/sync/multibaas-index.ts).

## Fallback

If MultiBaas is behind, failing or not configured, or a range is older than the index start block, the engine reads Base RPC logs for that range and labels every row with the cause (dashboard.md §6.6). Rows kept from the fallback keep their label.

## Budget

MultiBaas is queried at most every 10 minutes to fit the Free plan (2 events per second, 30,000 calls per month, 100 blocks of past logs). The rest of the engine runs every 2 minutes on Base RPC.

## Webhooks

Not used. No webhook was created on the deployment.
