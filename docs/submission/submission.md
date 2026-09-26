# ETHGlobal Tokyo 2026: submission text for Mamoru

Text for every field of the project form (rules in `requirements.md`). Voice rules: plain, factual, no em dash, no emoji in prose, no invented numbers, no yield or APY claims, no users, deposits or TVL, no earlier projects. MultiBaas and fork claims follow `specs/001-mamoru-v1/dashboard.md` §12.2 and §12.3. Every link points to `main`.

## 1. Project details

| Field | Value |
|---|---|
| Project name | Mamoru |
| Category | DeFi |
| Emoji | keep the current one |
| Demo link | https://app.mamoru.lol. Not https://mamoru.lol while its hero says "APY. DELIVERED.", which the claims policy forbids |

## 2. Short description (max 100 characters)

Option A (93 characters):

> Non-custodial savings account on Base. Passkey Safe, scoped Uniswap session, simulation mode.

Option B (89 characters):

> A passkey Safe on Base that plans Uniswap savings moves, simulates them, and never signs.

## 3. Description (min 280 characters)

Mamoru is a non-custodial savings account on Base. You own a Safe smart account through a passkey on your device and download a recovery kit before anything else happens. The server never holds an owner key.

A session key can act for the account only inside a written policy: it may call Uniswap v3 on Base, on registry addresses, with the account as recipient and a positive minimum on every swap and mint. You can revoke it at any time, and you can leave without Mamoru: with the kit and your passkey, you revoke the sessions, close the position and withdraw, with our engine, app and indexer all off.

In v1 production, Mamoru runs in simulation mode. It plans and simulates, and it does not sign or send transactions. Deposits are closed.

The dashboard shows Base only. Every figure carries its chain id and its source, as a chip such as "Base · block N" or "MultiBaas · Base · checked at block N". It shows what the account holds, what needs your decision, what Mamoru would do next and why, and the live state of the Uniswap pool in the plan, read from Base every 2 minutes.

The full cycle is verified on a Base fork pinned at block 51811000 with chain id 31337. Fork results are not capital and do not use MultiBaas. The last full run passed 42 of 42 scenarios: 24 session attacks with a leaked key, 3 walkaway scenarios, 6 engine scenarios from deposit to harvest, and 9 checks of the verification plane itself.

Live app: https://app.mamoru.lol. Repo: https://github.com/ottodevs/mamoru.

## 4. How it's made (min 280 characters)

Mamoru is a Bun workspaces monorepo in TypeScript, https://github.com/ottodevs/mamoru. It runs on Cloudflare Workers: the app Worker serves a Vite 8, React 19, TanStack Router and Query and Tailwind 4 single-page app plus a Hono API; a second, cron-triggered engine Worker reads Base every 2 minutes into a shared D1 database. The API serves the dashboard only from D1.

Account. The account is a Safe 1.4.1 with the Safe7579 adapter, so it uses ERC-7579 modules and ERC-4337 EntryPoint v0.7. The owner is a WebAuthn passkey through Safe's WebAuthn shared signer, bound inside Safe.setup through a MultiSend 1.4.1 delegatecall, so the counterfactual address commits to the passkey. The recovery kit holds every public parameter needed to deploy that exact Safe without us. There is no account SDK: everything is encoded with viem 2.56.9 against addresses pinned in packages/registry/base.json, each checked by code hash at Base block 51811000.

Sessions. packages/account/sessions/index.ts (toSmartSession, line 103) encodes a Rhinestone Smart Session. The grants in packages/policy name the allowed contracts and selectors and add argument rules through UniActionPolicy, plus time and usage limits. A session cannot install modules, change owners, approve an attacker or pay anyone but the account.

Uniswap. packages/uniswap-v3/src/index.ts builds SwapRouter02.exactInputSingle (line 24) with the account as recipient and a positive amountOutMinimum, and NonfungiblePositionManager mint (line 54) with ticks on the pool spacing and positive minimums, plus decreaseLiquidity, collect and burn. quote.ts quotes through QuoterV2 at a fixed block and derives the minimum. v1 uses one pool, USDC/cbBTC 0.05% on Base. In production the engine reads its slot0, liquidity, a TWAP and one hour of Swap, Mint and Burn at the safe block.

MultiBaas. The engine Worker reads the pool's Swap, Mint and Burn events from a Curvegrid MultiBaas deployment on Base, with a read-only key, and checks every row against Base RPC logs before it stores it; a probe matched 10 of 10 rows with nothing missing on either side. Rows older than the index start block come from Base RPC logs and are labeled. The browser never calls MultiBaas.

Verification. The fork runner in packages/scenarios starts Anvil on a Base fork pinned at block 51811000 with chain id 31337 and refuses Base chain ids, unpinned blocks and keys in argv. Session attacks send real batches to EntryPoint.handleOps and must be rejected by the chain. The engine scenarios run the same decision code against the fork through a loopback bundler that speaks the standard ERC-4337 methods (Alto is pinned but not installed): a deposit is entered with a swap and a mint, the swap minimum recomputed from QuoterV2 equals the signed one, the bundler receipt matches the UserOperationEvent, and a harvest converts fees to USDC and credits the Savings Log.

How we worked. We wrote the spec first with GitHub Spec Kit: constitution, spec, plan, dashboard spec, scenarios, threats and tasks are in inputs/ and specs/001-mamoru-v1. Brais and Otto decided the product, the design and every merge. AI agents implemented in parallel lanes on separate branches, and a second model reviewed each lane (docs/process/ai-attribution.md).

## 5. Tech stack answers

| Question | Answer |
|---|---|
| Ethereum developer tools | Foundry (anvil), viem |
| Blockchain networks | Base |
| Programming languages | TypeScript, SQL |
| Web frameworks | React, Vite, Hono, Tailwind CSS, TanStack Router, TanStack Query |
| Databases | Cloudflare D1 |
| Design tools | Brais and Otto decide |
| Other technologies | Bun, Cloudflare Workers (cron triggers), Safe 1.4.1, Safe7579, Rhinestone Smart Sessions, SafeWebAuthnSharedSigner, ERC-4337 EntryPoint v0.7, WebAuthn passkeys, Uniswap v3 (QuoterV2, SwapRouter02, NonfungiblePositionManager), Curvegrid MultiBaas, GitHub Spec Kit |

## 6. How AI tools were used

Spec-driven. Brais and Otto set the product spec (inputs/mamoru-spec-v1.md); the spec pack in specs/001-mamoru-v1 (spec, plan, dashboard, scenarios, threats, tasks) was drafted with AI and reviewed by the team, and it is how the agents were directed. Cursor Agent and Claude Code, both with Claude Opus 5.5, implemented most of the code in packages/, apps/ and scenarios/ in parallel lanes, each on its own branch and allowed to write only its own paths. Codex with GPT-6 Astra reviewed lane commits independently. Brais and Otto decided the product, the design and every merge. Every scenario result comes from a real run on the fork, not from a model. Full record: docs/process/ai-attribution.md.

## 7. Prize: Uniswap Foundation

How are you using this protocol:

> Mamoru's capital side is Uniswap v3 on Base. packages/uniswap-v3/src/index.ts builds SwapRouter02.exactInputSingle with the account as recipient and a positive amountOutMinimum, and NonfungiblePositionManager mint with ticks on the pool spacing and positive minimums, plus decreaseLiquidity, collect and burn. packages/uniswap-v3/src/quote.ts quotes through QuoterV2 at a fixed block. Addresses are pinned in packages/registry/base.json and checked by code hash at Base block 51811000.
>
> A session key may only call those selectors on those addresses, with argument rules. On a Base fork pinned at block 51811000 (chain id 31337), 24 scenarios use a leaked session key to swap or mint to an attacker, approve max, collect a foreign position or exceed caps, and the chain rejects every one. The engine scenarios enter the USDC/cbBTC 0.05% pool with a swap and a mint, check that the minimum recomputed from QuoterV2 equals the signed one, and harvest: collect the fees and swap the cbBTC part to USDC through SwapRouter02, leaving no allowance. In production the engine reads that pool on Base every 2 minutes for the dashboard. v1 production runs in simulation mode and does not sign or send.

Proof link: https://github.com/ottodevs/mamoru/blob/main/packages/uniswap-v3/src/index.ts#L24

Ease rating (1-10): 8 (Brais and Otto decide)

Notes:

> The v3 periphery signatures on Base were stable and encoding with viem was direct once ABIs were pinned. What cost time: SwapRouter02 on Base has no deadline in exactInputSingle, unlike the original SwapRouter, and we found that by comparing ABIs. One page per chain listing SwapRouter02, QuoterV2 and the position manager next to the deployed ABI version would have saved us that. Full write-up: https://github.com/ottodevs/mamoru/blob/main/FEEDBACK.md

## 8. Prize: Curvegrid (Best Digital Asset Dashboard)

How are you using this protocol:

> Mamoru's production dashboard on Base answers four questions for one smart account: what it holds, what needs the owner's decision, what Mamoru would do next and why, and what is happening in the Uniswap pool in its plan. The dashboard shows Base only. Every figure carries its chain id and its source, shown as a chip. Live at https://app.mamoru.lol.
>
> Mamoru links the Uniswap V3 pool it uses, the NonfungiblePositionManager and EntryPoint v0.7 on Base in MultiBaas. The engine Worker reads the pool's Swap, Mint and Burn events through MultiBaas event queries that Mamoru's server checks against Base RPC before showing them (probe: 10 of 10 rows reconciled). Rows older than the index start block come from Base RPC logs and are labeled. The key is read-only in the DApp User group; the browser never calls MultiBaas. In v1 production, Mamoru runs in simulation mode. It plans and simulates, and it does not sign or send transactions. Not covered: DAO votes, vesting schedules and RWA ownership analytics.

Proof link: https://github.com/ottodevs/mamoru#how-multibaas-was-used

Ease rating (1-10): 7 (Brais and Otto decide)

Notes:

> Creating the Base deployment, linking three contracts with canonical ABIs and scoping a read-only key was direct, and event queries matched Base RPC one to one. What cost time: the Free plan refused our seven-day start block (100-block limit), limit is 50 rows per page, log_index cannot be selected, the contract status endpoint returns 403 for the DApp User key, and Swap aggregates compared ticks as strings, so we use rows only. Details: https://github.com/ottodevs/mamoru/blob/main/docs/multibaas.md

## 9. Future

Brais and Otto decide (grants, accelerators).

## 10. Evidence behind the numbers

| Claim | Evidence |
|---|---|
| 42 of 42, 24 session attacks, 3 walkaway, 6 engine, 9 lab | `evidence/scenarios/fork-run-20260926T185126Z-84632e.md` |
| QuoterV2 minimum equals the signed one; receipt matches `UserOperationEvent`; harvest credited to the Savings Log | same file, T003 section |
| MultiBaas 10 of 10 reconciled; formats; plan limits | `evidence/multibaas/mb-02-04-results.md`, `evidence/multibaas/mb-01-deployment.md` |
| Pool read every 2 minutes | `apps/mamoru-engine/wrangler.jsonc` (cron `*/2 * * * *`) |
