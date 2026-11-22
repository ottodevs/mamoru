# Monad history: HyperSync for backfill, RPC for live reads

otto/mamoru#397. Monad makes a block every 300 to 400 ms, and providers cap `eth_getLogs` at 100 to 1,000 blocks per
call (QuickNode 100, Alchemy 1,000, Chainstack 10,000 on Growth). A backfill read that way after 7 Nov took hours for
a gap of 680k to 1M blocks.

## Measured (22 Nov 2026, rpc.monad.xyz, USDC Transfer logs)

| Read | Page | Result |
|---|---|---|
| `eth_getLogs` | 100 blocks | 89 ms per page, about 1,100 blocks/s with no rate limit, so 1M blocks takes 15 min and 10,000 calls per filter |
| `eth_getLogs` | 1,000 blocks | refused on every page |
| HyperSync `/height` | none | answers without a key |
| HyperSync `/query` | about 2.3M blocks per request (Envio) | 401 without a key |

A Safe's history uses three filters: USDC in, USDC out and position NFTs in. That makes 30,000 RPC calls per account for
1M blocks, before 429s and retries. Over the shared operator RPC budget (#379, #419) that is the hours we saw.

## Options

- **HyperSync** (`https://monad.hypersync.xyz`, Envio). One request covers what 10,000+ pages cover. A free key works
  for development; production plans are usage-based. Trust: HyperSync is one third party, so its answer is checked
  against the chain. A sample of ranges is re-read through `eth_getLogs` on our own providers and compared log by log
  (`scripts/monad/hypersync-probe.ts` does this), and the cursor only moves over blocks at or below a finalized block
  read from our own RPC.
- **Sliced `eth_getLogs`** (a304b5e8, #389 cursors). It needs no third party, but its cost grows with block count;
  it fits live reads (a few pages a minute) and not backfill.
- **Goldsky** (#161). A managed subgraph or pipeline: more setup, and also a third party.

## Recommendation

HyperSync for backfill (position history, deposits, owner logs), with spot checks against our own RPC as above.
Paid RPC for live reads near the head. Sliced `eth_getLogs` stays the fallback when HyperSync does not answer.

## To finish the evaluation

1. An `ENVIO_API_TOKEN` created with the Mamoru account at https://app.envio.dev/api-tokens. It is stored like the
   other operator secrets and never written here.
2. `ENVIO_API_TOKEN=... bun scripts/monad/hypersync-probe.ts --safe <a Monad Safe> --blocks 1000000` prints
   HyperSync's time and request count, the trust check (exit 1 on any difference) and the `eth_getLogs` baseline for
   the same range.
3. With those numbers: wire HyperSync into the Monad history catch-up behind a flag, with the same spot check.
