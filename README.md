# Mamoru

> **ETHGlobal Mumbai 2026 · Continuity track.** Mamoru started at ETHGlobal Tokyo and has run in production with real funds since. Everything built during Mumbai is the commit range [`ethglobal-mumbai-start...ethglobal-mumbai-submission`](https://github.com/ottodevs/mamoru/compare/ethglobal-mumbai-start...main) (5 Nov 21:00 IST to 7 Nov 09:00 IST).
>
> **Built in Mumbai** (status per item in `ETHGLOBAL.md`): 1) per-account cap raised from 1,000 to 10,000 USDC, live in production, proven on a Base fork up to 60,000; 2) full harvest: collected fees sold to USDC in their own step and reinvested, vault yield counted as earned; 3) public [Stats](https://app.mamoru.lol/stats) and a Portfolio + Stats menu, no account needed to read Stats. All three are in production. First harvest with the new engine on mainnet: [collect](https://monadscan.com/tx/0xd758f36474508fb183a66426f139b406687893262eadaa9671c36d1f920b880a), then [sale of the harvested WMON to USDC](https://monadscan.com/tx/0xb70997961c2f32e916dc8f84f5bbfdbae1cb5062a54a6d265ca980d70d675e29).
>
> Before vs during, planning artifacts and AI use: [`ETHGLOBAL.md`](ETHGLOBAL.md) · Video: _TBD_ · Live: [app.mamoru.lol](https://app.mamoru.lol)

Automated, non-custodial savings. You deposit USDC, Mamoru keeps it working in DeFi, and the yield it earns becomes stablecoins. Only you can take money out.

- App: [app.mamoru.lol](https://app.mamoru.lol)
- Website: [mamoru.lol](https://mamoru.lol) ([how it works](https://mamoru.lol/#works), [risks](https://mamoru.lol/risks), [terms](https://mamoru.lol/terms))
- X: [@entermamoru](https://x.com/entermamoru)

## How it works

1. **Create your account.** A passkey on your phone or laptop becomes the only owner of a [Safe](https://safe.global) smart account on Base. No seed phrase, no email. You download a recovery kit that lets you reach the account without Mamoru.
2. **Authorize Mamoru.** You sign to let Mamoru's engine manage the money inside fixed on-chain rules: which contracts, which tokens, how much per window, and money only to your own Safes.
3. **Add USDC on Base.** The engine splits it across buckets and places each one:
   - **Stable**: stablecoin liquidity or an ERC-4626 lending vault.
   - **Balance**: bluechip/USDC liquidity on Uniswap v3.
   - **Growth**: a higher-yield pool, on Monad for the multichain plan, reached through Circle CCTP.
4. **Mamoru keeps it working.** It re-ranges positions that leave their range, harvests fees when they cover the gas, and holds when the market is unsafe. Every move shows in your history with its transaction.
5. **Withdraw any time.** Your passkey signs the withdrawal. There is no lockup.

Fee: 10 % of the yield harvested. No yield, no fee. There is no token.

## Status (November 2026)

| | |
|---|---|
| Live | Base mainnet. New accounts: 50 % stablecoin pool, 40 % cbBTC/USDC, 10 % WETH/USDC on Uniswap v3. Cap of 10,000 USDC per account since 7 Nov 2026 (existing accounts renew once). |
| In beta, test accounts | 50 / 35 / 15 plan with Growth on Monad (WMON/USDC) and the Stable bucket in Morpho `gtUSDCp`. |
| Next | One authorization (V4 policy): sign to create and to withdraw, nothing else. New pools, vaults and chains need no new signature. |

This is beta software that handles real money. Read [the risks](https://mamoru.lol/risks) before you deposit.

## Safety model

- **Non-custodial.** The passkey is the only owner of the Safe. Mamoru's servers hold no owner key.
- **Bounded engine.** The engine signs with a session key that an on-chain policy limits to specific contracts, selectors, tokens, price bands and spending windows. We test it as if the key had leaked: every attack in [`scenarios/catalog/`](scenarios/catalog/) must be refused on a Base fork.
- **Walkaway.** With the recovery kit you can withdraw with Mamoru switched off ([guide](docs/walkaway.md)).
- **Open code.** Everything that touches funds is in this repository under the MIT license.

## Repository

| Path | What |
|---|---|
| [`apps/mamoru-app`](apps/mamoru-app) | Web app and API (Cloudflare Worker + D1) |
| [`apps/mamoru-operator`](apps/mamoru-operator) | Operator per chain: owner routes, relayer, engine loop, bridge legs |
| [`apps/mamoru-engine`](apps/mamoru-engine) | Read model: chain sync and snapshots |
| [`apps/mamoru-lab-runner`](apps/mamoru-lab-runner) | Strategy Lab runner (backtests against the production decision code) |
| [`packages/decide`](packages/decide) | The engine's decisions: enter, re-range, harvest, hold, exit |
| [`packages/policy`](packages/policy) | Strategy versions (buckets, pools, ranges) and session grants |
| [`packages/account`](packages/account) | Safe, passkey owner, sessions, recovery kit |
| [`packages/uniswap-v3`](packages/uniswap-v3), [`packages/routing`](packages/routing) | Uniswap calls and cross-chain routes (CCTP and others) |
| [`packages/registry`](packages/registry) | Pinned addresses and code hashes per chain |
| [`contracts/`](contracts) | On-chain action policies (Solidity, Foundry) |
| [`packages/backtest`](packages/backtest), [`packages/lab-bench`](packages/lab-bench), [`packages/lab-agent`](packages/lab-agent) | Strategy Lab |
| [`scenarios/`](scenarios), [`packages/scenarios`](packages/scenarios) | Fork scenarios: attacks, walkaway, engine cycles |
| [`specs/`](specs) | Specs 001 to 013, one folder each (011–013: ETHGlobal Mumbai) |

## Run it locally

Requirements: [Bun](https://bun.sh) 1.3.13 and Foundry's `anvil` (version pinned in [`scenarios/manifest.json`](scenarios/manifest.json)).

```sh
bun install
bun run typecheck
bun test
bun run release:check          # typecheck, tests and build, what CI runs
```

Fork scenarios need a Base archive RPC in `.env` as `RPC_URL` (gitignored; never on the command line):

```sh
bun run scenarios run                          # the whole catalog
bun run scenarios run --only SESS-01,WALK-02   # a subset
```

Contributions: see [CONTRIBUTING.md](CONTRIBUTING.md).

## History

Mamoru started at ETHGlobal Tokyo, 25 to 27 September 2026. The submission README of that weekend is kept in [`docs/submission/ethglobal-tokyo-readme.md`](docs/submission/ethglobal-tokyo-readme.md). How AI tools were used: [`docs/process/ai-attribution.md`](docs/process/ai-attribution.md).

Built by Brais and Otto ([@ottodevs](https://github.com/ottodevs)).

## License

[MIT](LICENSE)
