# Whitechain · go-to-market plan

Written during ETHGlobal Mumbai 2026 for the Whitechain prize. Whitechain asked us for a go-to-market strategy, not code: its new chain has no DEX, lending or liquidity live yet, and Mamoru routes deposits to venues that already exist. On an empty chain there is nothing to route to. So this document is the integration plan we will run with Whitechain once the first venue is up, and the evidence that we can ship it.

## 1. What Mamoru is

Mamoru means *to protect* in Japanese. It is a non-custodial savings account that runs itself: you add stablecoins, approve once with a passkey, and an engine puts them to work in your own account. You can withdraw any time, and no one, including us, can move your money elsewhere. It started at ETHGlobal Tokyo and runs with real funds on Base mainnet, with a Growth bucket on Monad mainnet reached through Circle CCTP.

## 2. Market

Many people hold crypto that sits idle. Their options are low yield, custody on an exchange, or DeFi positions they have to watch every day. We sell one thing: your money works on its own, stays yours, and you take it out whenever you want. Mamoru earns 10 % of the yield it harvests, so revenue grows with deposits, not with headcount.

The code is open on purpose, so anyone can audit it. The hard part is running it with real money: permissions the user limits on-chain, an engine that only acts when it beats the gas cost, and funds that move between chains without custody.

## 3. Segment

People who hold crypto and do not know what to do with it, crypto-native or not. We start with crypto natives putting in 500 to 1,000 USDC: they validate the product for everyone else. Behind them come non-natives with 1,000 to 40,000 sitting idle. That second group is where the volume is, and it is the retail base of an exchange like WhiteBIT.

## 4. Channels we already run

- **Founder-led, in person.** Live demos at Devcon and at ETHGlobal Mumbai: people open an account on their own phone, then we follow up one by one from a list of named prospects.
- **A narrow network on purpose.** Farcaster as the beachhead, small and connected, with a 2 to 4 week deadline to show deposits.
- **Chain integrations.** Each chain we join brings its community. We did it with Monad. Whitechain is the next one.

## 5. The offer: Mamoru on Whitechain

A new chain's hardest problem is the first liquidity: venues without users, and users without venues. We cover both sides:

- **We deploy the AMM**, a Uniswap v3 fork (GPL), on Whitechain.
- **Whitechain seeds the liquidity** in the stablecoin it chooses first: USDT, EURC or USDC.
- **Mamoru brings the demand.** Every deposit becomes liquidity in that AMM from day one.

We start with a capped pilot, as we did on Monad, and raise the cap as the evidence comes in. Later the same engine can be opened to integrators and agents, and become the path that turns exchange users into users of the chain.

## 6. The ask

Liquidity for launch, the stablecoin to start with, and one technical contact. In return Whitechain gets an AMM, a savings product live on its chain, and a team that has already added a chain once.

## Why we can deliver it

What already exists in this repository and is the template for a new chain:

- One registry file per chain: [`packages/registry/base.json`](../../packages/registry/base.json) and [`packages/registry/monad.json`](../../packages/registry/monad.json). A new chain is a new file, not a new engine.
- The same engine runs per chain, and USDC moves between chains over Circle CCTP with no fee.
- During Mumbai: the per-account cap went from 1,000 to 10,000 USDC, proven on a fork against real pool depth; the harvest now sells fees to USDC and reinvests them; and public Stats show TVL, accounts and earnings with no login ([`ETHGLOBAL.md`](../../ETHGLOBAL.md)).

## Questions for Whitechain

1. What does the chain settle on today, and which stablecoins and bridges does it have?
2. Is a DEX or lending market deployed, or on the way?
3. Is there a budget for launch liquidity incentives?
