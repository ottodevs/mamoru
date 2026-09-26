# MB-02 to MB-04: MultiBaas queries on Base, results

Recorded 2026-09-26 from the Base read-model lane's probe and the production engine, as reported to the integrator. No keys, no deployment URL, no user addresses in this file. Code: [`packages/multibaas/src/queries.ts`](../../packages/multibaas/src/queries.ts), [`apps/mamoru-engine/src/sync/multibaas-index.ts`](../../apps/mamoru-engine/src/sync/multibaas-index.ts).

## Reconciliation (MB-03)

| Query | Used as a source | Result |
|---|---|---|
| MBQ-01 `Swap` and MBQ-02 `Mint`/`Burn` on the USDC/cbBTC 0.05% pool, sent as one query (`poolActivity`) | yes | Rows after the index start block are matched against Base `eth_getLogs` with the same filter and range. Probe: 10 of 10 rows reconciled, 0 rows only in RPC after the start, 0 rows only in MultiBaas. Reconciled rows carry `source = multibaas`, `check = reconciled` |
| Rows before the index start block | from Base RPC logs | Labeled `PROJ_SOURCE_FALLBACK_RPC` with cause `MB_BEFORE_START_BLOCK` ("before MultiBaas start") |
| MBQ-03, MBQ-04, MBQ-05, MBQ-08 (position events, position transfers, account userOps, account swaps) | no | Builders exist and are unit-tested. In simulation mode no account has positions or userOps on Base, so there is nothing to reconcile yet. No claim is made for them |
| MBQ-06 events of one transaction | no | Returned an empty list for a pool `Swap` transaction |
| MBQ-07 `Swap` aggregates | no, never a source | Found unreliable: tick min and max came back compared as strings, and a `greaterthan` filter was ignored. Statistics come from reconciled rows instead |

## Formats found (MB-02)

- Event inputs are selected by `inputIndex`.
- `limit` maximum is 50 rows per page.
- `log_index` cannot be selected.
- Several events in one query are accepted, which is why MBQ-01 and MBQ-02 go in one call.
- The per-contract indexing status endpoint returns 403 for the read-only "DApp User" key, so index health is read from the deployment status and from the rows themselves.

## Budget (MB-04)

- The engine Worker runs every 2 minutes on Base at the `safe` block, reading pool state and a one-hour `Swap`/`Mint`/`Burn` window from Base RPC logs (for example 64 swaps and 1 liquidity change in one window).
- MultiBaas is queried at most every 10 minutes (`MB_SYNC_EVERY_SECONDS = 600`) to stay inside the Free plan (2 events per second indexing, 30,000 calls per month).
- Only the USDC/cbBTC 0.05% pool, the one pool in the Conservador plan, is linked and queried.
