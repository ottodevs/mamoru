# MB-01: MultiBaas deployment on Base and linked contracts

Recorded 2026-09-26 from the integrator's (L0) report after the account was created (lane L5). No keys, no deployment URL, no user addresses in this file.

| Field | Value |
|---|---|
| Deployment | Curvegrid MultiBaas, name `mamoru`, Free tier |
| Chain | Base mainnet. `GET /api/v0/chains/ethereum/status` returns `chainID` 8453 |
| Created | 2026-09-26, about 20:05 CEST |
| API key | read-only, in the least-privileged "DApp User" group. Creating addresses or keys with it returns 403. Used only by the engine Worker (`apps/mamoru-engine`), never by the browser |
| Webhooks, Cloud Wallets, signers | none created |

## Linked contracts (dashboard.md §6.2)

| Alias | Contract label | Address on Base | ABI source |
|---|---|---|---|
| `mamoru-pool-usdc-cbbtc-500` | `uniswap-v3-pool` | `0xfBB6Eed8e7aa03B138556eeDaF5D271A5E1e43ef` (USDC/cbBTC 0.05%) | `@uniswap/v3-core` 1.0.1 |
| `mamoru-npm` | `uniswap-v3-npm` | `0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1` (NonfungiblePositionManager) | `@uniswap/v3-periphery` 1.4.4 |
| `mamoru-entrypoint-v07` | `erc4337-entrypoint-v07` | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` (EntryPoint v0.7) | `@account-abstraction/contracts` 0.7.0 |

Addresses match `packages/registry/base.json`.

## Observed

- Event queries on the pool return `Swap` rows.
- Transaction events lookup (`GET /api/v0/events?tx_hash=`, MBQ-06) answers, but returned an empty list for a pool `Swap` transaction (see `mb-02-04-results.md`).

## Refused by the plan

- The spec's starting block for the pool, `-302400` (seven days), was refused with 403 "request exceeds the plan's past logs max depth limit". The Free plan allows at most 100 blocks back.
- The Free plan caps indexing at 2 events per second and 30,000 calls per month.
- Consequence: history before the link block is read from Base RPC logs and labeled as fallback (`MB_BEFORE_START_BLOCK`, "before MultiBaas start").

## Next

Query results: [`mb-02-04-results.md`](mb-02-04-results.md).
