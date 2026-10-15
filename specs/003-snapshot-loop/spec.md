# 003: One snapshot loop per chain, fees computed off-chain

Ticket: otto/mamoru#136. Builds toward #129 (yield ledger), #128 (idle money says what it waits for) and #130 (ops by
environment and chain). Status: phase 1 in review.

## Why

On 15 Oct a visible home tab cost ~42k CU/h: `GET /funding` ran `readSafe` (81 CU) every 6 s per tab (#135 fixes the
symptom). Every consumer reads the chain on its own, per account: funding per request, the armed watcher per
account, the engine per review. Cost grows with users and with open tabs. And no harvest has fired yet, so the
only yield a user can see is fees that are still inside the positions, which today nobody reads (the dashboard marks
the savings ledger `not_observed`).

## What

One loop per chain in the operator reads, at one block, every Safe it serves (active or armed) and the pools they
hold:

| Batch (one Multicall3 `aggregate3`, chunked at 100 calls) | Reads |
|---|---|
| 0 | `eth_blockNumber`; every later batch is pinned to it |
| 1 | per pool: `slot0`, `feeGrowthGlobal0X128`, `feeGrowthGlobal1X128`; per Safe: ETH, token balances, NFT count, `getThreshold` (fails when the Safe has no code: the deployed check, free) |
| 2 | `tokenOfOwnerByIndex` for Safes with positions |
| 3 | `positions(tokenId)` |
| 4 | `ticks(lower)`, `ticks(upper)` per position, deduplicated per pool |

Uncollected fees per position are computed with the pool's own arithmetic (`getFeeGrowthInside`, then
`tokensOwed + liquidity * (inside - insideLast) / 2^128`, all differences modulo 2^256): `packages/uniswap-v3/src/fees.ts`.
Checked on 15 Oct at block 52644273: 11 of 11 live positions equal a simulated `collect` exactly
(`apps/mamoru-operator/scripts/snapshot-verify.ts`).

Per Safe the snapshot carries idle (tokens outside positions, valued in USDC at the pricing pool), LP principal,
uncollected fees and total, plus every position with its amounts and fees.

## Safety

- Read-only. Nothing decides from the snapshot in phase 1. Engine decisions keep their own reads, trusted providers
  (`MAMORU_RPC_TRUSTED`) and staleness checks (`EHG_*`); a later phase may feed the engine only through the same
  checks, never around them.
- `GET /snapshot` is signed like `/metrics` (HMAC over method, path and minute; a `/metrics` signature does not open
  it). It answers 404 while the loop is off and 503 before the first read. Account keys are cut to 8 characters.
- A failed read keeps the previous snapshot and its one-line error; over the keyed CU budget the loop slows to one
  read a minute, like the other loops that can wait.

## Cost (Alchemy CU: `eth_blockNumber` 10, `eth_call` 26)

Measured 15 Oct: 20 Safes (5 with positions, 11 positions) = 6 requests = ~140 CU per snapshot.

| Safes (with positions) | requests per snapshot | CU per snapshot | CU/h at 30 s | CU/h at 60 s |
|---|---|---|---|---|
| 5 live + 15 armed (today) | 6 | ~140 | ~17k | ~8k |
| 50 (25) | ~10 | ~250 | ~30k | ~15k |
| 500 (250) | ~85 | ~2.2k | ~265k | ~130k |

Compared with today's per-request reads it is flat in open tabs and in reviews. At hundreds of accounts a full read
every 30 s is too much for the free keyed tier, so phase 3 changes what is re-read, not how often the app sees money:

- token ids and ticks of a tokenId never change: reuse them while the Safe's NFT count and the op journal say no
  position was opened or closed (batches 2 and 4 drop to only new positions; ~2 requests at 5 accounts);
- balances re-read only on events: Alchemy Address Activity webhook for transfers to our Safes (free tier: 5 webhooks
  of up to 100k addresses), pools' `Swap` logs for prices and fee growth;
- route the `snapshot` component to QuickNode (Build plan at 1.1% of 80M credits on 15 Oct).

Default interval 30 s (`MAMORU_SNAPSHOT_MS`).

## Storage (D1, `migrations/d1/0007_account_snapshots.sql`, not applied in phase 1)

- `account_snapshot_latest (chain_id, address)`: the last snapshot of each Safe, with `env`.
- `account_daily (day, chain_id, address)`: first and last snapshot of each UTC day, with `env`; #129 adds
  `collected_usdc` and `gas_paid_wei`. Yield of a day = fees_close - fees_open + collected.

The operator has no D1 binding. A Worker cron (the app's `*/10` or the engine's) pulls `GET /snapshot` through the
same signed path and upserts both tables; `env` comes from the accounts table once #130 adds it there ('prod' until then).

## Phases

1. **Reader, fee math, verification script, migration file, `GET /snapshot` behind `MAMORU_SNAPSHOT=1` (off).** This PR.
2. Turn it on in the operator; Worker pulls into D1 (apply 0007); `/ops` shows yield per account; the app shows
   "earned so far" growing between harvests (#129, #128).
3. Consumers move to the snapshot: funding reads it (replacing #135's 15 s cache), the armed watcher reads it; the
   reuse and webhook changes above.
4. The engine takes observations from the snapshot when its block passes the same staleness and provider checks.

## Rollback

Phase 1: unset `MAMORU_SNAPSHOT` (default) and restart; nothing else reads it. Phase 2: the same, the D1 tables stay
and stop updating. Later phases keep the per-consumer reads behind a flag until the snapshot path has run a week.
