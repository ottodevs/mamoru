# Mamoru

Mamoru v1 is a non-custodial savings account on Base. You own a Safe smart account through a passkey, add a backup owner, and keep a recovery kit that lets you leave without Mamoru. A scoped session key may only call Uniswap v3 on Base within a written policy. The dashboard shows what the account holds, what needs your decision, and what Mamoru would do next, with the source and chain of every figure.

In v1 production, Mamoru runs in simulation mode. It plans and simulates, and it does not sign or send transactions. Deposits are closed. ([spec](specs/001-mamoru-v1/spec.md), [dashboard spec](specs/001-mamoru-v1/dashboard.md))

- App: https://app.mamoru.lol (simulation mode: passkey onboarding, counterfactual Safe on Base, recovery kit, dashboard). Pool data on the dashboard [PENDING L4]
- Landing: https://mamoru.lol ([ottodevs/mamoru-landing](https://github.com/ottodevs/mamoru-landing))
- Built at ETHGlobal Tokyo 2026 (25 to 27 September). First commit 25 September 14:03 CEST.

### Where to look

| What | Where |
|---|---|
| Uniswap v3 calls: `exactInputSingle` on SwapRouter02, `mint`, `decreaseLiquidity`, `collect`, `burn` on the NonfungiblePositionManager | [`packages/uniswap-v3/src/index.ts`](packages/uniswap-v3/src/index.ts) lines [24](packages/uniswap-v3/src/index.ts#L24), [54](packages/uniswap-v3/src/index.ts#L54), [98](packages/uniswap-v3/src/index.ts#L98), [107](packages/uniswap-v3/src/index.ts#L107), [118](packages/uniswap-v3/src/index.ts#L118) |
| Base addresses and code hashes at block 51811000 (Uniswap v3, Safe, ERC-7579, EntryPoint v0.7) | [`packages/registry/base.json`](packages/registry/base.json), [`scenarios/manifest.json`](scenarios/manifest.json) |
| Session key limits (Rhinestone Smart Sessions on a Safe with ERC-7579) | [`packages/account/sessions/index.ts`](packages/account/sessions/index.ts#L103), [`packages/policy/src/grants.ts`](packages/policy/src/grants.ts) |
| Counterfactual Safe, owner walkaway, recovery kit | [`packages/account/recovery/index.ts`](packages/account/recovery/index.ts), [`packages/account/owner/index.ts`](packages/account/owner/index.ts) |
| Fork scenarios and runner | [`scenarios/catalog/`](scenarios/catalog/), [`packages/scenarios/runner/`](packages/scenarios/runner/) |
| Uniswap feedback | [`FEEDBACK.md`](FEEDBACK.md) |
| Spec pack that directed the work | [`inputs/mamoru-spec-v1.md`](inputs/mamoru-spec-v1.md), [`specs/001-mamoru-v1/`](specs/001-mamoru-v1/), [`.specify/memory/constitution.md`](.specify/memory/constitution.md) |

How this was built: Otto and Brais set the product, the spec and the screens. Cursor Agent, Claude Code, Codex and Grok wrote most of the code against the spec pack above, one lane per area, and an integrator merged the lanes into `main`. Third-party code is used as published: Safe, Rhinestone modules, Uniswap v3 periphery ABIs, viem.

## One sentence

Mamoru v1 is a non-custodial autonomous savings account on Base whose dashboard shows every figure with its chain and source, and which runs in simulation mode: it plans and simulates, and it does not sign or send transactions.

## How MultiBaas was used

MultiBaas is the indexer behind the production dashboard on Base. Details and evidence: [`docs/multibaas.md`](docs/multibaas.md).

- Deployment `mamoru` on Base mainnet (chain id 8453), Free tier. Linked with their aliases ([evidence](evidence/multibaas/mb-01-deployment.md)):
  - `mamoru-pool-usdc-cbbtc-500`, label `uniswap-v3-pool`: the USDC/cbBTC 0.05% Uniswap V3 pool Mamoru uses.
  - `mamoru-npm`, label `uniswap-v3-npm`: the NonfungiblePositionManager.
  - `mamoru-entrypoint-v07`, label `erc4337-entrypoint-v07`: EntryPoint v0.7.
- Mamoru links the Uniswap V3 pool it uses, the NonfungiblePositionManager and EntryPoint v0.7 on Base in MultiBaas.
- Only the engine Worker calls MultiBaas, with a read-only key in the least-privileged "DApp User" group. The browser never calls it.
- Event queries on the pool return `Swap` rows, and the transaction events lookup works ([evidence](evidence/multibaas/mb-01-deployment.md)).
- Reconciliation: [PENDING L4] Pool swaps, liquidity changes, position history and account operations come from MultiBaas event queries that Mamoru's server checks against Base RPC before showing them. L0 keeps in this sentence only the queries with `PROJ_RECONCILED` in MB-02 to MB-04, or replaces it with dashboard.md §12.4 wording if none reconciled.
- If MultiBaas is behind or unavailable, the dashboard reads Base RPC logs and labels every row. [PENDING L4: DASH-17 and BASE-02 evidence]
- History older than the link block comes from Base RPC logs, labeled "before MultiBaas start", because the Free plan cannot index further back (see "Experience with MultiBaas").
- No webhooks, Cloud Wallets or signers were created. MultiBaas does not sign, send or decide anything for Mamoru, and it does not index the Base fork.
- Not covered: DAO votes, vesting schedules and RWA ownership analytics.

## Team handles

TODO-HANDLES

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
```

Each run writes `scenarios/.artifacts/runs/<runId>/report.json`. The last full run on `main`'s catalog: 36 of 36 pass, no attack passed ([evidence](evidence/scenarios/fork-run-20260926T181151Z-0ce9e2.md)).

| Scenarios | What they prove |
|---|---|
| SESS-01 to SESS-23, SESS-25 | The session key is treated as leaked. Swaps or mints to an attacker, max approvals, transfers out, foreign positions, over-cap amounts, expired or revoked sessions and wrong chain ids are all rejected, each with its reason code |
| WALK-01, WALK-02, WALK-04 | The owner, or the passkey owner, leaves without Mamoru: with the engine, the app and MultiBaas off, revokes the sessions and withdraws. WALK-04 deploys the counterfactual Safe from the recovery kit at the same address |
| LAB-01 to LAB-06, LAB-08, LAB-09, M05 | The verification plane refuses Base chain ids, unpinned blocks, wrong hashes, keys in argv and foreign snapshots |
| T003 harvest scenarios (M01 to M04, DEP-01) | [PENDING L1] |
| BASE-01, BASE-02, CYCLE-01 | [PENDING L4/L0] |

Worker environment variable names (values are never committed): `BASE_RPC_URL`, `MULTIBAAS_URL`, `MULTIBAAS_API_KEY`, `CORE_DRY_RUN` (always `true` in v1). D1 database `mamoru`, binding `DB`, schema in [`migrations/d1/`](migrations/d1/). [PENDING L3/L4: final list and local dev commands for `apps/mamoru-app` and `apps/mamoru-engine`]

## Experience with MultiBaas

What worked:

- Creating the Base deployment and linking three contracts with canonical ABIs (`@uniswap/v3-core` 1.0.1, `@uniswap/v3-periphery` 1.4.4, `@account-abstraction/contracts` 0.7.0) was direct. The chain status endpoint returned chain id 8453 ([evidence](evidence/multibaas/mb-01-deployment.md)).
- The "DApp User" group gave us a key that can read but cannot create addresses or keys (403), which is what a server-side indexer client should hold.
- Arbitrary event queries returned pool `Swap` rows, and the per-transaction events lookup worked.

What failed or cost time:

- Our spec asked for a starting block seven days back (`-302400`) on the pool. The Free plan refused it with 403 "request exceeds the plan's past logs max depth limit" (100 blocks). We now read older history from Base RPC logs and label it as fallback.
- The Free plan caps indexing at 2 events per second and 30,000 calls per month. The engine keeps the Base RPC path live for that reason.
- [PENDING L4] Results of MB-02 to MB-04 (query formats accepted, which queries reconciled, mismatches), including failures.
