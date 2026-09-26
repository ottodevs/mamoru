# ETHGlobal Tokyo 2026: submission text for Mamoru

Draft for every field of the project form (see `requirements.md` for the rules). L0 pastes these at freeze after resolving each [PENDING Lx]. Voice rules: plain, factual, no em dash, no emoji in prose, no invented numbers, no yield or APY claims, no users, deposits or TVL. MultiBaas and fork claims follow `specs/001-mamoru-v1/dashboard.md` §12.2 and §12.3.

Permanent links use `main`. The old branch `spec/mamoru-v1` no longer exists; every field that mentions it must be replaced.

## 1. Project details

| Field | Value |
|---|---|
| Project name | Mamoru |
| Category | DeFi |
| Emoji | keep the current one |
| Demo link | https://app.mamoru.lol [PENDING L2/L3: keep https://mamoru.lol if the app is not public at freeze] |

## 2. Short description (max 100 characters)

Option A (93 characters):

> Non-custodial savings account on Base. Passkey Safe, scoped Uniswap session, simulation mode.

Option B (89 characters):

> A passkey Safe on Base that plans Uniswap savings moves, simulates them, and never signs.

## 3. Description (min 280 characters)

Mamoru is a non-custodial savings account on Base. You own a Safe smart account through a passkey on your device, add a backup owner, and download a recovery kit before anything else happens. The server never holds an owner key.

A session key can act for the account only inside a written policy: it may call Uniswap v3 on Base, on registry addresses, with the account as recipient and a positive minimum on every swap and mint. You can revoke it at any time, and you can leave without Mamoru: the owner walkaway revokes the sessions, closes the position and withdraws with the engine, the app and the indexer all off.

In v1 production, Mamoru runs in simulation mode. It plans and simulates, and it does not sign or send transactions. Deposits are closed.

The dashboard shows Base only. Every figure carries its chain id and its source, as a chip such as "Base · block N" or "MultiBaas · Base · checked at block N". It shows what the account holds, what needs your decision, what Mamoru would do next and why, and the state of the Uniswap pool in the plan. [PENDING L2/L3/L4: confirm each view is live on app.mamoru.lol with real Base pool data]

The full cycle is verified on a Base fork pinned at block 51811000 with chain id 31337. Fork results are not capital and do not use MultiBaas. The last full run passed 36 of 36 scenarios: 24 session attacks with a leaked key, 3 walkaway scenarios and 9 checks of the verification plane itself. [PENDING L1: add the T003 harvest scenarios if they pass before freeze]

Live app: https://app.mamoru.lol. Landing: https://mamoru.lol. Repo: https://github.com/ottodevs/mamoru.

## 4. How it's made (min 280 characters)

Mamoru is a Bun and TypeScript monorepo, https://github.com/ottodevs/mamoru. Everything runs on Cloudflare: the app Worker serves a Vite and React single-page app and a small API, and an engine Worker syncs Base state into a D1 database on a cron. [PENDING L2/L3/L4 merge]

Account. The account is a Safe 1.4.1 with the Safe7579 adapter, so it can use ERC-7579 modules and ERC-4337 EntryPoint v0.7. The owner is a WebAuthn passkey through Safe's WebAuthn shared signer, plus a backup owner. The address is counterfactual: we compute it from the setup before it exists, and the recovery kit holds every parameter needed to deploy it without us. There is no account SDK; we encode everything with viem against ABIs and addresses pinned in packages/registry/base.json, each checked by code hash at Base block 51811000.

Sessions. packages/account/sessions/index.ts (toSmartSession, line 103) encodes a Rhinestone Smart Session. The grants in packages/policy name the allowed contracts and selectors and add argument rules through UniActionPolicy, plus time and usage limits. A session cannot install modules, change owners, approve an attacker or pay anyone but the account.

Uniswap. packages/uniswap-v3/src/index.ts builds SwapRouter02.exactInputSingle (line 24) with the account as recipient and a positive amountOutMinimum, and NonfungiblePositionManager mint (line 54) with ticks on the pool spacing and positive minimums, plus decreaseLiquidity, collect and burn. v1 uses one pool, USDC/cbBTC 0.05% on Base. [PENDING L1: QuoterV2 quotes and the harvest path on the fork] [PENDING L4: the engine reads slot0 and Swap, Mint and Burn logs of that pool on Base]

MultiBaas. The engine Worker reads Base through a Curvegrid MultiBaas deployment with the pool, the NonfungiblePositionManager and EntryPoint v0.7 linked, using a read-only key. The browser never calls it. [PENDING L4: name only the queries that reconciled against Base RPC.] The Free plan refused a seven-day start block (100-block limit), so older history comes from Base RPC logs and is labeled as fallback.

Verification. The fork runner in packages/scenarios starts Anvil on a Base fork pinned at block 51811000 with chain id 31337 and refuses Base chain ids, unpinned blocks and keys in argv. The session attacks send real batches to EntryPoint.handleOps and must be rejected by the chain. The Base RPC URL stays in the environment; it never reaches argv or logs.

How we worked. We wrote the spec first with GitHub Spec Kit: the constitution, spec, plan, dashboard spec, scenarios, threats and tasks are in inputs/ and specs/001-mamoru-v1. Otto and Brais set the product, the spec and the screens; Cursor Agent, Claude Code, Codex and Grok wrote most of the code in parallel lanes against that pack, and an integrator merged the lanes into main.

## 5. Tech stack answers

| Question | Answer |
|---|---|
| Ethereum developer tools | Foundry (anvil), viem |
| Blockchain networks | Base |
| Programming languages | TypeScript, SQL |
| Web frameworks | React, Vite [PENDING L2] |
| Databases | Cloudflare D1 [PENDING L3/L4] |
| Design tools | Ot decides |
| Other technologies | Bun, Cloudflare Workers, Astro (landing), Safe, Safe7579, Rhinestone Smart Sessions, ERC-4337 EntryPoint v0.7, WebAuthn passkeys, Uniswap v3, Curvegrid MultiBaas, GitHub Spec Kit |

## 6. How AI tools were used

Otto and Brais set the product, the copy, the screens and the closed spec (inputs/mamoru-spec-v1.md). The spec pack in specs/001-mamoru-v1 (spec, plan, dashboard, scenarios, threats, tasks) was drafted with AI and is in the public repo; it is how the agents were directed. Cursor Agent, Claude Code, Codex and Grok implemented the packages (registry, policy, account, uniswap-v3, scenarios), the app and the engine, one lane per area of the repo with a written brief. Codex also reviewed commits during the first tasks. The Uniswap call builders, the session encoding and the fork scenarios were written with the spec files open, and every scenario result comes from a real run on the fork, not from a model.

## 7. Prize: Uniswap Foundation

How are you using this protocol:

> Mamoru's capital side is Uniswap v3 on Base. packages/uniswap-v3/src/index.ts on main builds SwapRouter02.exactInputSingle with the account as recipient and a positive amountOutMinimum, and NonfungiblePositionManager mint with ticks on the pool spacing and positive minimums for both tokens, plus decreaseLiquidity, collect and burn. The addresses are pinned in packages/registry/base.json and checked by code hash at Base block 51811000.
>
> A session key may only call those selectors on those addresses, with argument rules (packages/account/sessions/index.ts, packages/policy). On a Base fork pinned at block 51811000 (chain id 31337), 24 scenarios use a leaked session key to swap or mint to an attacker, approve max, collect a foreign position or exceed caps; the chain rejects every one (evidence/scenarios/). [PENDING L1: the harvest path, collect then swap to USDC through QuoterV2 and SwapRouter02, on the fork.] [PENDING L4: the dashboard reads the USDC/cbBTC 0.05% pool on Base.] In v1 production Mamoru runs in simulation mode and does not sign or send.

Proof link: https://github.com/ottodevs/mamoru/blob/main/packages/uniswap-v3/src/index.ts#L24

Ease rating (1-10): 8 (unchanged; Ot decides)

Notes:

> The v3 periphery signatures on Base were stable and encoding with viem was direct once ABIs were pinned. What cost time: SwapRouter02 on Base has no deadline in exactInputSingle, unlike the original SwapRouter, and we found that by comparing ABIs. One page per chain listing SwapRouter02, QuoterV2 and the position manager next to the deployed ABI version would have saved us that. Full write-up: https://github.com/ottodevs/mamoru/blob/main/FEEDBACK.md

## 8. Prize: Curvegrid (Best Digital Asset Dashboard)

How are you using this protocol:

> Mamoru's production dashboard on Base answers four questions for one smart account: what it holds, what needs the owner's decision, what Mamoru would do next and why, and what is happening in the Uniswap pool in its plan. Every figure carries its chain id and its source, shown as a chip. The dashboard shows Base only. [PENDING L2/L3/L4: confirm views live at https://app.mamoru.lol]
>
> The engine Worker reads Base through our MultiBaas deployment on Base (chain id 8453) with the USDC/cbBTC 0.05% pool, the NonfungiblePositionManager and EntryPoint v0.7 linked, using a read-only key in the DApp User group. The browser never calls MultiBaas. [PENDING L4: "Pool swaps, liquidity changes, position history and account operations come from MultiBaas event queries that Mamoru's server checks against Base RPC before showing them", naming only reconciled queries.] If MultiBaas is behind or unavailable, the dashboard reads Base RPC logs and labels every row [PENDING L4: DASH-17 and BASE-02]. In v1 production, Mamoru runs in simulation mode. It plans and simulates, and it does not sign or send transactions. Not covered: DAO votes, vesting schedules and RWA ownership analytics.

Proof link: https://github.com/ottodevs/mamoru#how-multibaas-was-used

Ease rating (1-10): 7 (unchanged; Ot decides)

Notes:

> Creating the Base deployment, linking three contracts with canonical ABIs and scoping a read-only key to the DApp User group was direct. The Free plan refused our seven-day start block with a 403 (100-block past-logs limit), so history older than the link comes from Base RPC logs and is labeled as fallback. [PENDING L4: MB-02 to MB-04 results.] Details: https://github.com/ottodevs/mamoru/blob/main/docs/multibaas.md

## 9. Future

Ot decides (grants, accelerators).

## 10. Claims checklist for L0 at freeze

| Claim | Depends on | Keep if |
|---|---|---|
| Live app URL and views | L2, L3 | app.mamoru.lol serves onboarding and the dashboard after the last deploy |
| React, Vite, D1 in tech stack | L2, L3, L4 | merged on main |
| Engine reads the pool on Base | L4 | merged and deployed; D1 has pool rows |
| Reconciled MultiBaas queries | L4 | MB-02 to MB-04 report `PROJ_RECONCILED` for the named queries |
| RPC fallback labeled | L4 | DASH-17 and BASE-02 pass |
| Harvest on the fork | L1 | M01 to M04 and DEP-01 pass in a recorded run |
| "36 of 36" and "24 session attacks" | done | evidence/scenarios/fork-run-20260926T181151Z-0ce9e2.md; update both if a newer full run is recorded |
