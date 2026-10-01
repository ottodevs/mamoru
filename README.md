# Mamoru

Mamoru v1 is a non-custodial savings account on Base. You own a Safe smart account through a passkey and keep a recovery kit that lets you leave without Mamoru. A scoped session key may only call Uniswap v3 on Base within a written policy. The dashboard shows what the account holds, what needs your decision, and what Mamoru would do next, with the source and chain of every figure.

As of 26 September 2026, app.mamoru.lol runs a live path on Base, with a hard cap of 25 USDC per account. Within that cap, your passkey signs starting the allocation, transferring funds out and stopping it, and a relayer sends those transactions; once started, the engine enters and manages a Uniswap v3 position for you with a session key. Above the cap, and for the harvest and every session-key attack, everything is still only demonstrated on a Base fork. ([spec](specs/001-mamoru-v1/spec.md), [dashboard spec](specs/001-mamoru-v1/dashboard.md))

- App: https://app.mamoru.lol (passkey onboarding, counterfactual Safe on Base, recovery kit, live start, transfer and stop up to 25 USDC per account, dashboard with the Base pool read every 2 minutes)
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
| Live operator: owner routes, relayer, engine's own bundler | [`apps/mamoru-operator/src/`](apps/mamoru-operator/src/), [`packages/account/live/index.ts`](packages/account/live/index.ts) |
| Fork scenarios and runner | [`scenarios/catalog/`](scenarios/catalog/), [`packages/scenarios/runner/`](packages/scenarios/runner/) |
| Uniswap feedback | [`FEEDBACK.md`](FEEDBACK.md) |
| How AI tools were used | [`docs/process/ai-attribution.md`](docs/process/ai-attribution.md) |
| Spec pack that directed the work | [`inputs/mamoru-spec-v1.md`](inputs/mamoru-spec-v1.md), [`specs/001-mamoru-v1/`](specs/001-mamoru-v1/), [`.specify/memory/constitution.md`](.specify/memory/constitution.md) |

How this was built: Brais and Otto decided the product, the design and every merge. AI agents wrote most of the code against the spec pack above, in parallel lanes, each reviewed by a second model ([details](docs/process/ai-attribution.md)). Third-party code is used as published: Safe, Safe7579, Rhinestone Smart Sessions, Uniswap v3 ABIs, viem.

## One sentence

Mamoru v1 is a non-custodial autonomous savings account on Base whose dashboard shows every figure with its chain and source. Within a 25 USDC per account cap it runs live, with the owner's passkey signing every start, transfer and stop; above the cap, and for the harvest and the session-key attacks, it is demonstrated on a Base fork.

## Live path on Base

app.mamoru.lol runs a live path on Base (chain id 8453), capped at 25 USDC per account (`LIVE_CAP_USDC` in [`packages/account/live/index.ts`](packages/account/live/index.ts)).

The account owner is a WebAuthn passkey held by Safe's `SafeWebAuthnSharedSigner`, the sole owner of a Safe 1.4.1 with the Safe7579 adapter and Rhinestone Smart Sessions installed. The owner signs three actions, each as one Safe transaction:

- **Start.** Deploys the Safe if it is not deployed yet, and enables the `enter-swap` and `enter-mint` session grants, sized to the deposit found on chain.
- **Transfer out.** Reduces open positions first if the idle USDC on hand is short, then sends USDC to the address the owner chose.
- **Stop.** Revokes every session grant, closes and burns every position, and swaps the cbBTC side to USDC. USDC stays in the Safe.

A deposit above the cap does not start: the operator fails the pending start with `DEPOSIT_OVER_CAP` and the amounts, reports it on the account's funding view, and the app says so. The owner withdraws the excess with Transfer out (the relayer deploys the Safe first if it was never deployed), then starts.

The owner never pays gas or sends a transaction directly. A relayer sends the owner's signed `execTransaction` and pays for it, and tops up the Safe's ETH balance when needed. The same relayer also bundles the engine's own operations: once a session grant is active, the engine (the same Engine package proven on the Base fork, [`packages/scenarios/driver/engine.ts`](packages/scenarios/driver/engine.ts)) enters and manages a Uniswap v3 USDC/cbBTC 0.05% position with the session key, through ERC-4337 userOps that the operator bundles itself, calling `handleOps` on EntryPoint v0.7 with its own relayer rather than a third-party bundler.

The engine Worker ([`apps/mamoru-engine`](apps/mamoru-engine)) stays read-only: it still only reads Base every 2 minutes for the dashboard. The live operator is a separate Bun service, [`apps/mamoru-operator`](apps/mamoru-operator), gated by `MAMORU_LIVE=1` and `CHAIN_ID=8453`; the app Worker forwards owner routes to it over an HMAC-signed internal call ([`packages/domain/src/app-api.ts`](packages/domain/src/app-api.ts), `AccountContext`).

Harvest (collecting Uniswap fees and converting them to USDC) and the 24 session-key attack scenarios remain demonstrated on the Base fork pinned at block 51811000, not on Base mainnet.

First live transactions on Base, Basescan links filled in by L0 after the run:

| Action | Tx |
|---|---|
| Start (activate) | `TX_ACTIVATE` |
| Engine swap | `TX_SWAP` |
| Engine mint | `TX_MINT` |
| Transfer out | `TX_TRANSFER` |
| Stop | `TX_STOP` |

## How MultiBaas was used

MultiBaas is one of two sources for the pool history on the production dashboard on Base; the other is Base RPC. Details and evidence: [`docs/multibaas.md`](docs/multibaas.md).

- Deployment `mamoru` on Base mainnet (chain id 8453), Free tier. Linked with their aliases ([evidence](evidence/multibaas/mb-01-deployment.md)):
  - `mamoru-pool-usdc-cbbtc-500`, label `uniswap-v3-pool`: the USDC/cbBTC 0.05% Uniswap V3 pool Mamoru uses.
  - `mamoru-npm`, label `uniswap-v3-npm`: the NonfungiblePositionManager.
  - `mamoru-entrypoint-v07`, label `erc4337-entrypoint-v07`: EntryPoint v0.7.
- Mamoru links the Uniswap V3 pool it uses, the NonfungiblePositionManager and EntryPoint v0.7 on Base in MultiBaas.
- Only the engine Worker calls MultiBaas, with a read-only key in the least-privileged "DApp User" group. The browser never calls it.
- The engine Worker runs every 2 minutes on Base at the `safe` block. Pool state (`slot0`, liquidity, TWAP, balances) and account state come from Base RPC. Pool swaps and liquidity changes (MBQ-01 and MBQ-02, `Swap`, `Mint` and `Burn` of the USDC/cbBTC 0.05% pool) come from MultiBaas event queries that Mamoru's server checks against Base RPC before showing them. Each reconciled row is shown as "MultiBaas · Base · checked at block N". Probe: 10 of 10 rows reconciled, none missing on either side ([evidence](evidence/multibaas/mb-02-04-results.md), [code](apps/mamoru-engine/src/sync/multibaas-index.ts)).
- MBQ-03 to MBQ-05 and MBQ-08 (position history, position transfers, account operations, account swaps) are built and tested but not used yet: live accounts are capped at 25 USDC and hold at most one small position on Base, so there is not yet enough position history, transfers or account-level operations to show. MBQ-06 and MBQ-07 are not used (see "Experience with MultiBaas").
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

Lab replay. [app.mamoru.lol/lab](https://app.mamoru.lol/lab) replays three runs recorded on the same fork, with a timeline of keyframes and the engine's decision at each one: a harvest that waits until fees clear three times the operation cost, a position that leaves its range and is held without a transaction, and an entry refused while the pool price is far from its 30-minute average. Every frame comes from the real engine and `decide()` on fork state; the recorder stops without writing if the fork does not do what the script expects. Re-record with `bun run packages/scenarios/tape/record.ts [harvest|out-of-range|pool-shock]` ([`packages/scenarios/tape/`](packages/scenarios/tape/), contract [`scenario-tape.ts`](packages/domain/src/scenario-tape.ts)).

The runner's bundler is a loopback bundler that speaks the standard ERC-4337 JSON-RPC methods and submits to EntryPoint v0.7 ([`packages/scenarios/bundler/`](packages/scenarios/bundler/)). Alto is pinned in the manifest but is not installed and was not used.

Each run writes `scenarios/.artifacts/runs/<runId>/report.json`. The catalog is now 45 scenarios, after the live-path receipt and bundle checks (`M03-RECEIPT`, `M04-BUNDLE`, `M04-OWNER`) that check the operator's own userOp receipt and the owner's passkey-signed `execTransaction` against the fork. Latest full run: see [`evidence/scenarios/`](evidence/scenarios/).

| Scenarios | What they prove |
|---|---|
| SESS-01 to SESS-23, SESS-25 | The session key is treated as leaked. Swaps or mints to an attacker, max approvals, transfers out, foreign positions, over-cap amounts, expired or revoked sessions and wrong chain ids are all rejected, each with its reason code |
| WALK-01, WALK-02, WALK-04 | The owner, or the passkey owner, leaves without Mamoru: with the engine, the app and MultiBaas off, revokes the sessions and withdraws. WALK-04 deploys the counterfactual Safe from the recovery kit at the same address |
| LAB-01 to LAB-06, LAB-08, LAB-09, M05 | The verification plane refuses Base chain ids, unpinned blocks, wrong hashes, keys in argv and foreign snapshots |
| M01 to M04, M03-RECEIPT, M04-BUNDLE, M04-OWNER, DEP-01, M07 step 1 | The engine on the fork: no capital means hold; a safe deposit is entered with a swap and a mint; the swap minimum is recomputed from QuoterV2 and equals the signed one; the bundler receipt matches the `UserOperationEvent`; the owner's passkey-signed `execTransaction` matches what the live operator sends; a harvest collects fees and converts them to USDC, credited to the Savings Log (1.012308 USDC in the recorded run) with the position left in place |

Workers (names only, values are never committed; local values go in `.dev.vars` or `~/.config/mamoru-operator/env`, both gitignored):

| Worker | Variables |
|---|---|
| `apps/mamoru-app` (SPA and API) | `MODE`, `CHAIN_ID`, `CORE_DRY_RUN`, `SESSION_SECRET` |
| `apps/mamoru-engine` (cron every 2 minutes) | `CHAIN_ID`, `CORE_DRY_RUN`, `BASE_RPC_PUBLIC`, `BASE_RPC_URL`, `BASE_LOGS_RPC_URL` (optional), `MULTIBAAS_URL`, `MULTIBAAS_API_KEY`, `MULTIBAAS_POOL_START_BLOCK` (optional) |
| `apps/mamoru-operator` (live owner and engine path, a Bun service, not a Cloudflare Worker) | `MAMORU_LIVE`, `CHAIN_ID`, `BASE_RPC_URL`, `OPERATOR_SECRET`, relayer private key, `MAMORU_POLICY` (optional) |
| fork scenarios | `RPC_URL` (environment only, never argv) |

`CORE_DRY_RUN` is always `true` in v1 for both Cloudflare Workers: they read Base and Uniswap state but never sign or send. Signing and sending live, within the 25 USDC per account cap, happens only in `apps/mamoru-operator`, gated separately by `MAMORU_LIVE=1`. Both Workers share the D1 database `mamoru`, binding `DB`, schema in [`migrations/d1/`](migrations/d1/).

```sh
cd apps/mamoru-app && bun run dev              # SPA on Vite
cd apps/mamoru-app && bun run dev:worker       # app Worker (API) with wrangler
cd apps/mamoru-engine && bun run dev           # engine Worker, cron testable locally
cd apps/mamoru-engine && bun run sync:once     # one sync against Base
cd apps/mamoru-engine && bun run mb:probe      # MultiBaas probe used for the evidence
cd apps/mamoru-operator && bun run start       # live operator, gated by MAMORU_LIVE=1, relayer key in ~/.config/mamoru-operator/env
cd apps/mamoru-operator && bun run e2e:fork    # live owner and engine path proven on the Base fork
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
