# Routing layer research — canonical routes, interop, EEZ

otto/mamoru#181. What backs `packages/routing`'s adapters, and what was researched but not built because it
is not usable today. Verified 18 Oct 2026 against each provider's own docs, cross-checked on-chain where noted.
Secondary sources (news coverage, not a primary doc) are flagged explicitly; nothing here is taken from memory
without a link next to it.

## Direction table: canonical/official routes

| Direction | Asset | Official route | Typical time | Fee | Status |
|---|---|---|---|---|---|
| Any -> any (Ethereum, Base, Monad, ...) | USDC | **CCTP V2** `depositForBurn` (Circle) | Fast ~seconds, Standard ~13-19 min on Ethereum | 0–few bps, [`/v2/burn/USDC/fees`](https://developers.circle.com/cctp/howtos/get-transfer-fee) | **Implemented** (`src/adapters/cctp.ts`) |
| Ethereum (1) -> Base (8453) | ETH | **Base StandardBridge** deposit (`bridgeETHTo`) | Minutes (L1 inclusion + L2 derivation; no official minute figure published) | None beyond gas | **Implemented** (`src/adapters/canonical.ts`) |
| Base (8453) -> Ethereum (1) | ETH | **Base StandardBridge** withdrawal (`bridgeETHTo` on L2, then prove+finalize on L1) | **5 days** (single-proof dispute game, current since the Beryl upgrade, 25 Jun 2026); a TEE+ZK dual-proof path from the Azul upgrade (28 May 2026) can finalize in ~1 day, but which path a withdrawal takes is not something this quote controls | None beyond gas | **Implemented**, quoting the always-available 5-day path |
| Ethereum (1) -> Base (8453) | USDC | Base StandardBridge | N/A | N/A | **Not offered.** Base's standard bridge can only mint a legacy wrapped `USDbC`, not native USDC — Base's own USDC has been issued directly by Circle via CCTP since Sept 2023. Use CCTP. |

Sources: [developers.circle.com/cctp/cctp-supported-blockchains](https://developers.circle.com/cctp/cctp-supported-blockchains), [developers.circle.com/cctp/howtos/get-transfer-fee](https://developers.circle.com/cctp/howtos/get-transfer-fee), [docs.base.org/chain/base-contracts](https://docs.base.org/chain/base-contracts), [specs.optimism.io/protocol/bridges.html](https://specs.optimism.io/protocol/bridges.html), [docs.base.org/base-chain/network-information/bridging-and-withdrawals](https://docs.base.org/base-chain/network-information/bridging-and-withdrawals), [docs.base.org/upgrades/beryl/overview](https://docs.base.org/upgrades/beryl/overview), [docs.base.org/upgrades/azul/proofs](https://docs.base.org/upgrades/azul/proofs), [circle.com/blog/usdc-now-available-natively-on-base](https://circle.com/blog/usdc-now-available-natively-on-base).

### A structural fact that changes how "Base is an OP Stack L2" should be read

Base left Optimism's OP Stack for its own independently-operated execution/proving stack ("base/base": a Base
Reth execution client, a new consensus client, TEE+ZK proofs replacing classic optimistic fault proofs) on
**18 Feb 2026**, removing Optimism from Base's Security Council while keeping sequencer revenue. Azul (28 May
2026) and Beryl (25 Jun 2026) are the first upgrades on this independent stack — both official Base upgrades,
not third-party fast paths. This is reported by multiple outlets, not an EF/Optimism primary doc (Base
diverging from them is the story): [theblock.co](https://www.theblock.co/post/403003/base-launches-azul-on-mainnet-pushing-coinbases-ethereum-l2-toward-full-decentralization),
[thedefiant.io](https://thedefiant.io/base-launches-azul-upgrade-takes-step-toward-stage-2-decentralization).
Practically: Base's contracts (`L1StandardBridge`, `OptimismPortal`, the `0x4200...` predeploys) are still named
and shaped like any OP Stack chain's — docs.base.org still calls the L1 contract `OptimismPortal`, not
`OptimismPortal2` — but Base no longer automatically inherits whatever the Superchain does next (see interop,
below).

## Superbridge

**Not an official Base or Optimism product.** Base's own ecosystem-bridges page lists Superbridge as a
third-party option alongside Brid.gg and Garden, with an explicit disclaimer that Coinbase "assumes no
responsibility for their operations": [docs.base.org/base-chain/network-information/ecosystem-bridges](https://docs.base.org/base-chain/network-information/ecosystem-bridges.md).
It is a UI layer over the canonical bridges of several OP Stack chains (OP Mainnet, Base, Zora, and reportedly
Mode/Unichain/Soneium/Lisk/Swellchain per secondary sources only — not independently confirmed against
Superbridge's own site this round). No public API or SDK was confirmed from a primary source; third-party
listings mention one with commercial pricing, unverified. **Not implemented**: it adds a UI, not a new
protocol — the StandardBridge adapter already covers the same underlying contracts for Base.

## Superchain interop

`L2ToL2CrossDomainMessenger` and `SuperchainTokenBridge` are real OP Stack predeploys for near-instant L2<->L2
messaging without routing through L1: [docs.optimism.io interop predeploy reference](https://docs.optimism.io/app-developers/reference/contracts/interop/predeploy).
Status is genuinely unclear as of this research: Optimism's own "Building a Unified Superchain" post frames
interop as future work and does not name Base or carry a firm 2026 mainnet date in what was fetched. Secondary
news reporting (not confirmed against a primary Optimism post) says Superchain governance passed "Upgrade 20" on
16 Sept 2026 targeting mainnet interop activation 24 Sept 2026 — and, separately, that Base left the Superchain
in Feb 2026 (consistent with the OP Stack departure above). No primary Base or Optimism source was found
confirming whether Base is currently part of Superchain interop either way. **Not implemented**: even if live
for some OP Stack chains, it is not verified for any pair this package quotes (Ethereum, Base, Monad — Monad is
not an OP Stack chain at all).

## "Ethereum Economic Zone" (EEZ)

Real, but young, and not primary-sourced by this research — no post was found on blog.ethereum.org,
ethereum.org, or ethresear.ch; only secondary news coverage (Decrypt, The Block, The Defiant, Forklog). Per that
coverage: announced at EthCC Cannes on 29 Mar 2026 by Gnosis and Zisk, with Ethereum Foundation co-funding and
support, framing a "synchronous composability" model where participating chains let a contract on one EEZ chain
call another EEZ chain (or L1) and get a response within the same transaction, with ETH as the default gas
asset — intended to cut L2 fragmentation and duplicated bridges. Founding members cited: Aave, Titan, Beaver
Build, Centrifuge, xStocks. Vitalik Buterin is reported as commenting on/promoting the concept, but no primary
essay formally defining it under this name was found.

**Verdict: not usable today.** As of 18 Oct 2026 this is an early-stage (~7 month old) coordination framework
and alliance, not live mainnet infrastructure with a public spec or a deployed reference implementation. No
adapter was built for it, and none should be until it has an actual integration surface (an SDK, a contract
address, an API — something to call).

## Adapters implemented, and why each one is scoped the way it is

| Adapter | Asset(s) | Chains | Mode | Why |
|---|---|---|---|---|
| `cctp.ts` | USDC | Ethereum, Base, Monad (any pair) | session-key | Circle's own official route. `mintRecipient` is `depositForBurn`'s 3rd argument, fixed-position bytes32 — EQUAL-pinnable by a `UniActionPolicy`. Domains: Ethereum 0, Base 6, Monad 15. Monad has no Fast transfer (Circle's docs mark it N/A — Standard attestation is already fast there). `TokenMessengerV2` = `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`, identical across all three chains (CREATE2). |
| `across.ts` | USDC only | Ethereum, Base, Monad (any pair) | session-key | `depositV3`'s `depositor`/`recipient` are fixed-position addresses. ETH deliberately excluded: Across bridges it via WETH, and no WETH address per chain was verified to the same standard as USDC this round. SpokePool addresses: Ethereum `0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5`, Base `0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64`, Monad `0xd2ecb3afe598b746F8123CaE365a598DA831A449` (Across supports Monad). Validation logic mirrors the proven `checkQuote` in `apps/mamoru-operator/src/bridge-out.ts` (otto/mamoru#133). |
| `canonical.ts` | ETH only | Ethereum <-> Base only | session-key | Base's own StandardBridge. USDC explicitly refused (see direction table). |
| `relay.ts` | USDC, ETH | any pair both sides support | owner-only | Relay (relay.link) picks a solver/route per request — no fixed calldata offset to pin ahead of time. Stayed on the v1 endpoint: v2 began requiring an API key from 2 Oct 2026, which would break the "no paid APIs" rule — **flag: if v1 is retired the same way, this adapter needs re-pointing or dropping.** |
| `lifi.ts` | USDC, ETH | any pair both sides support | owner-only | LI.FI (li.quest), same "picks its own route" reasoning. Charges a documented 0.25% service fee on top of whatever the underlying route costs. |
| `debridge.ts` | USDC, ETH | any pair both sides support | owner-only | deBridge DLN — the "one more aggregator" slot, chosen over Bungee/Socket because its quote+tx endpoint was confirmed genuinely keyless (50 req/min public tier). Charges an order-creation fee in the source chain's native asset on top of whatever it takes from the bridged token (carried in `Quote.value`). Monad must be addressed as deBridge's internal id `100000030`, not its EVM chain id `143` — confirmed live. |

All three aggregator adapters decode the calldata they are about to return and refuse the quote outright if the
account's address cannot be found among its ABI-encoded words (`src/recipient.ts`) — this is the "decode the
returned calldata and refuse it unless the recipient is the account" rule from the design note, applied before
the owner ever sees the quote, not just before signing it.

**Compliance-screen false positive, worth knowing when testing by hand:** deBridge's compliance check flags the
repeated-digit address `0x1111...1111` as high-risk (`COMPLIANCE_ADDRESS_BLOCKED`); LI.FI rejects both
`0x1111...1111` and `0x2222...2222` with a misleadingly worded `"Zero address is provided"` 400. `0x4444...4444`
is clean on every provider this package calls — used throughout the recorded test fixtures and the live smoke
script.

## What was out of scope for adapters, deliberately

- **Fast-withdrawal third parties** (Brid.gg, Garden, Superbridge) for Base's 5-day L2->L1 delay: third-party
  trust assumptions outside this ticket's "official or verified public API" bar.
- **Superchain interop, EEZ**: not usable infrastructure today (see above).
- **ERC-7683, 7715, 5792, 7484, Rhinestone Warp, Everclear, Eco**: named in the design note's round-1 research as
  unverified and out of scope for that round; still unverified, still out of scope here — a future ticket, not
  this one.
