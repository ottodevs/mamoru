---
name: curvegrid-multibaas
description: How MultiBaas may be used in Mamoru. Read before specifying the dashboard or webhooks.
---

# Curvegrid MultiBaas

Source: docs.curvegrid.com, checked 2026-09-26. SaaS with a web UI, REST API, and TypeScript and Go SDKs. A deployment is per network. Base indexing is not assumed until a real event query succeeds.

## Use

- Link Uniswap V3 pools, the NonfungiblePositionManager, and the EntryPoint used by the account.
- Event queries for liquidity, collects, and per-position history.
- Webhook type `event.emitted` to wake a review early.
- Decoded explorer links from the savings log.
- Server-side API key only. Minimum role. CORS is irrelevant because the browser does not call MultiBaas.

## Do not use

- Cloud Wallets, Azure KMS, or any vendor-held key.
- Signing, submitting, or speeding up Mamoru user operations.
- `transaction.included`. That callback covers Cloud Wallet transactions, not ERC-4337 user operations.
- Treating `Collect` as yield. It can include principal. Reconcile with the operation and an RPC read.
- A webhook as a GO. The motor re-reads the chain. If the webhook is missing, cron still runs.
- Fork indexing. Anvil events are not MultiBaas history. Label the two sources apart.

## Prize

Track: Best Digital Asset Dashboard, 1,000 USD. Judged on idea and technical execution. MultiBaas is optional for the form and mandatory in this spec: Mamoru uses it as the read model of the production dashboard.

The dashboard must do three things from the brief:

1. Show the holdings so the user can understand their value.
2. List the actions that need a decision.
3. Show the operational decision, with the reason.

The ideas in the brief map like this:

- DeFi analytics: pool swaps, liquidity, fee movement, and in-range state for the account's positions and the curated pools. Event queries on MultiBaas. RPC wins on conflict.
- Treasury: idle, LP, and the savings drawer. Liquidate or convert only through the Uniswap V3 path already in the constitution.
- Cross-chain: every figure carries a chain id. v1 fills Base only. A second chain is an empty column, not invented balances.
- RWA analytics, DAO votes, and vesting: out of scope. Name them as out of scope. Do not build them.

README, when implementation reaches it, has five parts: one sentence, how MultiBaas was used, the team, setup and tests, and the experience with MultiBaas including what failed. Claims require the acceptance evidence. Cloud Wallets stay forbidden.
