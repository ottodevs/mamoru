# Mamoru

Mamoru v1 is a non-custodial savings account on Base. You own a Safe smart account through a passkey and keep a recovery kit that lets you leave without Mamoru. A scoped session key may only call Uniswap v3 on Base within a written policy. The dashboard shows what the account holds, what needs your decision, and what Mamoru would do next, with the source and chain of every figure.

In v1 production, Mamoru runs in simulation mode. It plans and simulates, and it does not sign or send transactions. Deposits are closed. ([spec](specs/001-mamoru-v1/spec.md), [dashboard spec](specs/001-mamoru-v1/dashboard.md))

- App: https://app.mamoru.lol (simulation mode: passkey onboarding, counterfactual Safe on Base, recovery kit, dashboard with the Base pool read every 2 minutes)
- Landing: https://mamoru.lol ([ottodevs/mamoru-landing](https://github.com/ottodevs/mamoru-landing))
- Built at ETHGlobal Tokyo 2026 (25 to 27 September). First commit 25 September 14:03 CEST.

### Where to look

| What | Where |
|---|---|
| Uniswap v3 calls: `exactInputSingle` on SwapRouter02, `mint`, `decreaseLiquidity`, `collect`, `burn` on the NonfungiblePositionManager | [`packages/uniswap-v3/src/index.ts`](packages/uniswap-v3/src/index.ts) lines [24](packages/uniswap-v3/src/index.ts#L24), [54](packages/uniswap-v3/src/index.ts#L54), [98](packages/uniswap-v3/src/index.ts#L98), [107](packages/uniswap-v3/src/index.ts#L107), [118](packages/uniswap-v3/src/index.ts#L118) |
| Base addresses and code hashes at block 51811000 (Uniswap v3, Safe, ERC-7579, EntryPoint v0.7) | [`packages/registry/base.json`](packages/registry/base.json), [`scenarios/manifest.json`](scenarios/manifest.json) |
| Session key limits (Rhinestone Smart Sessions on a Safe with ERC-7579) | [`packages/account/sessions/index.ts`](packages/account/sessions/index.ts#L103), [`packages/policy/src/grants.ts`](packages/policy/src/grants.ts) |
| Counterfactual Safe, owner walkaway, recovery kit | [`packages/account/recovery/index.ts`](packages/account/recovery/index.ts), [`packages/account/owner/index.ts`](packages/account/owner/index.ts) |
| Harvest decision and execution on the fork (QuoterV2 minimum, collect, swap to USDC) | [`packages/decide/`](packages/decide/), [`packages/scenarios/driver/`](packages/scenarios/driver/), [`packages/uniswap-v3/`](packages/uniswap-v3/) |
| Base read model: engine Worker and MultiBaas client | [`apps/mamoru-engine/src/sync/`](apps/mamoru-engine/src/sync/), [`packages/multibaas/src/`](packages/multibaas/src/) |
| Fork scenarios and runner | [`scenarios/catalog/`](scenarios/catalog/), [`packages/scenarios/runner/`](packages/scenarios/runner/) |
| Uniswap feedback | [`FEEDBACK.md`](FEEDBACK.md) |
| How AI tools were used | [`docs/process/ai-attribution.md`](docs/process/ai-attribution.md) |
| Spec pack that directed the work | [`inputs/mamoru-spec-v1.md`](inputs/mamoru-spec-v1.md), [`specs/001-mamoru-v1/`](specs/001-mamoru-v1/), [`.specify/memory/constitution.md`](.specify/memory/constitution.md) |

How this was built: Brais and Otto decided the product, the design and every merge. AI agents wrote most of the code against the spec pack above, in parallel lanes, each reviewed by a second model ([details](docs/process/ai-attribution.md)). Third-party code is used as published: Safe, Safe7579, Rhinestone Smart Sessions, Uniswap v3 ABIs, viem.

## One sentence

Mamoru v1 is a non-custodial autonomous savings account on Base whose dashboard shows every figure with its chain and source, and which runs in simulation mode: it plans and simulates, and it does not sign or send transactions.

## How MultiBaas was used

MultiBaas is one of two sources for the pool history on the production dashboard on Base; the other is Base RPC. Details and evidence: [`docs/multibaas.md`](docs/multibaas.md).

- Deployment `mamoru` on Base mainnet (chain id 8453), Free tier. Linked with their aliases ([evidence](evidence/multibaas/mb-01-deployment.md)):
  - `mamoru-pool-usdc-cbbtc-500`, label `uniswap-v3-pool`: the USDC/cbBTC 0.05% Uniswap V3 pool Mamoru uses.
  - `mamoru-npm`, label `uniswap-v3-npm`: the NonfungiblePositionManager.
  - `mamoru-entrypoint-v07`, label `erc4337-entrypoint-v07`: EntryPoint v0.7.
- Mamoru links the Uniswap V3 pool it uses, the NonfungiblePositionManager and EntryPoint v0.7 on Base in MultiBaas.
- Only the engine Worker calls MultiBaas, with a read-only key in the least-privileged "DApp User" group. The browser never calls it.
- The engine Worker runs every 2 minutes on Base at the `safe` block. Pool state (`slot0`, liquidity, TWAP, balances) and account state come from Base RPC. Pool swaps and liquidity changes (MBQ-01 and MBQ-02, `Swap`, `Mint` and `Burn` of the USDC/cbBTC 0.05% pool) come from MultiBaas event queries that Mamoru's server checks against Base RPC before showing them. Each reconciled row is shown as "MultiBaas · Base · checked at block N". Probe: 10 of 10 rows reconciled, none missing on either side ([evidence](evidence/multibaas/mb-02-04-results.md), [code](apps/mamoru-engine/src/sync/multibaas-index.ts)).
- MBQ-03 to MBQ-05 and MBQ-08 (position history, position transfers, account operations, account swaps) are built and tested but not used yet: in simulation mode no account has positions or operations on Base. MBQ-06 and MBQ-07 are not used (see "Experience with MultiBaas").
- MultiBaas is queried at most every 10 minutes to fit the Free plan.
- History older than the index start block comes from Base RPC logs, labeled `PROJ_SOURCE_FALLBACK_RPC` with cause `MB_BEFORE_START_BLOCK` ("before MultiBaas start"), because the Free plan cannot index further back ([evidence](evidence/multibaas/mb-02-04-results.md)).
- No webhooks, Cloud Wallets or signers were created. MultiBaas does not sign, send or decide anything for Mamoru, and it does not index the Base fork.
- Not covered: DAO votes, vesting schedules and RWA ownership analytics.

## Team handles

- X: [@entermamoru](https://x.com/entermamoru)
- Web: [mamoru.lol](https://mamoru.lol)
- Code: [github.com/ottodevs/mamoru](https://github.com/ottodevs/mamoru)
- Team: Brais and Otto ([@ottodevs](https://github.com/ottodevs) on GitHub)

## Setup and tests

Requirements: [Bun](https://bun.sh) 1.3.13 and Foundry's `anvil` 1.7.1 (pinned in [`scenarios/manifest.json`](scenarios/manifest.json)).

```sh
bun install
bun run typecheck
bun test
```

Fork scenarios. The fork is the verification plane, not the product. The full cycle is verified on a Base fork pinned at block 51811000 with chain id 31337. Fork results are not capital and do not use MultiBaas.

```sh
# RPC_URL: a Base archive RPC. Put it in .env (gitignored), never on the command line.
bun run scenarios run                             # the whole catalog
bun run scenarios run --only SESS-01,WALK-02      # a subset
bun run scenarios demo                            # M01 to M04 with a readable summary, about 80 s
```

The runner's bundler is a loopback bundler that speaks the standard ERC-4337 JSON-RPC methods and submits to EntryPoint v0.7 ([`packages/scenarios/bundler/`](packages/scenarios/bundler/)). Alto is pinned in the manifest but is not installed and was not used.

Each run writes `scenarios/.artifacts/runs/<runId>/report.json`. The last full run of the catalog on `main`: 42 of 42 pass, no attack passed ([evidence](evidence/scenarios/fork-run-20260926T185126Z-84632e.md)).

| Scenarios | What they prove |
|---|---|
| SESS-01 to SESS-23, SESS-25 | The session key is treated as leaked. Swaps or mints to an attacker, max approvals, transfers out, foreign positions, over-cap amounts, expired or revoked sessions and wrong chain ids are all rejected, each with its reason code |
| WALK-01, WALK-02, WALK-04 | The owner, or the passkey owner, leaves without Mamoru: with the engine, the app and MultiBaas off, revokes the sessions and withdraws. WALK-04 deploys the counterfactual Safe from the recovery kit at the same address |
| LAB-01 to LAB-06, LAB-08, LAB-09, M05 | The verification plane refuses Base chain ids, unpinned blocks, wrong hashes, keys in argv and foreign snapshots |
| M01 to M04, DEP-01, M07 step 1 | The engine on the fork: no capital means hold; a safe deposit is entered with a swap and a mint; the swap minimum is recomputed from QuoterV2 and equals the signed one; the bundler receipt matches the `UserOperationEvent`; a harvest collects fees and converts them to USDC, credited to the Savings Log (1.012308 USDC in the recorded run) with the position left in place |

Workers (names only, values are never committed; local values go in `.dev.vars`, gitignored):

| Worker | Variables |
|---|---|
| `apps/mamoru-app` (SPA and API) | `MODE`, `CHAIN_ID`, `CORE_DRY_RUN`, `SESSION_SECRET` |
| `apps/mamoru-engine` (cron every 2 minutes) | `CHAIN_ID`, `CORE_DRY_RUN`, `BASE_RPC_PUBLIC`, `BASE_RPC_URL`, `BASE_LOGS_RPC_URL` (optional), `MULTIBAAS_URL`, `MULTIBAAS_API_KEY`, `MULTIBAAS_POOL_START_BLOCK` (optional) |
| fork scenarios | `RPC_URL` (environment only, never argv) |

`CORE_DRY_RUN` is always `true` in v1. Both Workers share the D1 database `mamoru`, binding `DB`, schema in [`migrations/d1/`](migrations/d1/).

```sh
cd apps/mamoru-app && bun run dev              # SPA on Vite
cd apps/mamoru-app && bun run dev:worker       # app Worker (API) with wrangler
cd apps/mamoru-engine && bun run dev           # engine Worker, cron testable locally
cd apps/mamoru-engine && bun run sync:once     # one sync against Base
cd apps/mamoru-engine && bun run mb:probe      # MultiBaas probe used for the evidence
```

## Experience with MultiBaas

What worked:

- Creating the Base deployment and linking three contracts with canonical ABIs (`@uniswap/v3-core` 1.0.1, `@uniswap/v3-periphery` 1.4.4, `@account-abstraction/contracts` 0.7.0) was direct. The chain status endpoint returned chain id 8453 ([evidence](evidence/multibaas/mb-01-deployment.md)).
- The "DApp User" group gave us a key that can read but cannot create addresses or keys (403), which is what a server-side indexer client should hold.
- Arbitrary event queries returned pool `Swap`, `Mint` and `Burn` rows that matched Base RPC logs one to one after the index start block (probe: 10 of 10). Several events in one query are accepted, so swaps and liquidity changes cost one call per page.

What failed or cost time:

- Our spec asked for a starting block seven days back (`-302400`) on the pool. The Free plan refused it with 403 "request exceeds the plan's past logs max depth limit" (100 blocks). We now read older history from Base RPC logs and label it as fallback.
- The Free plan caps indexing at 2 events per second and 30,000 calls per month. The engine keeps the Base RPC path live for that reason.
- Formats we had to discover: event inputs are selected by `inputIndex`, `limit` is at most 50 rows per page, and `log_index` cannot be selected, so rows are matched to RPC logs by block, transaction and decoded arguments.
- The per-contract indexing status endpoint returns 403 for the read-only DApp User key, so index health comes from the deployment status and the rows.
- MBQ-07 aggregates were unreliable for us: tick minimum and maximum came back compared as strings, and a `greaterthan` filter was ignored. We never use aggregates as a source; statistics come from reconciled rows.
- The per-transaction events lookup (MBQ-06) returned an empty list for a pool `Swap` transaction, so the Savings Log does not use it.
- To fit the Free plan, MultiBaas is queried at most every 10 minutes while the rest of the engine runs every 2 minutes.

## License

MIT, see [`LICENSE`](LICENSE).
