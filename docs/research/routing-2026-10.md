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

| Adapter | Asset(s) | Chains | Mode | recipientCheck | Why |
|---|---|---|---|---|---|
| `cctp.ts` | USDC | Ethereum, Base, Monad (any pair) | session-key | onchain-pinnable | Circle's own official route. `mintRecipient` is `depositForBurn`'s 3rd argument, fixed-position bytes32 — EQUAL-pinnable by a `UniActionPolicy`. Domains: Ethereum 0, Base 6, Monad 15. Monad has no Fast transfer (Circle's docs mark it N/A — Standard attestation is already fast there). `TokenMessengerV2` = `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`, identical across all three chains (CREATE2). |
| `across.ts` | USDC only | Ethereum, Base, Monad (any pair) | session-key | onchain-pinnable | `depositV3`'s `depositor`/`recipient` are fixed-position addresses. ETH deliberately excluded: Across bridges it via WETH, and no WETH address per chain was verified to the same standard as USDC this round. SpokePool addresses: Ethereum `0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5`, Base `0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64`, Monad `0xd2ecb3afe598b746F8123CaE365a598DA831A449` (Across supports Monad). Validation logic mirrors the proven `checkQuote` in `apps/mamoru-operator/src/bridge-out.ts` (otto/mamoru#133). |
| `canonical.ts` | ETH only | Ethereum <-> Base only | session-key | onchain-pinnable | Base's own StandardBridge. USDC explicitly refused (see direction table). ETH only on a chain confirmed ETH-native (`chains.ts`'s `nativeAsset`). |
| `relay.ts` | USDC, ETH | any pair both sides support, both ETH-native-verified for ETH requests | owner-only, **quote-only in practice** | **none** | Relay's deposit calldata carries the depositor, never the on-chain recipient (confirmed by testing with a different sender and recipient — see "Third hardening pass" below) — not executable by this package's own rule. Still decodes and refuses on a token/amount/value mismatch, to protect the quoted price's trustworthiness. Stayed on the v1 endpoint: v2 began requiring an API key from 2 Oct 2026 — **flag: if v1 is retired the same way, this adapter needs re-pointing or dropping.** |
| `lifi.ts` | USDC, ETH | per-origin-chain target allowlist (Ethereum, Base, Monad), both ETH-native-verified for ETH requests | owner-only | decoded-calldata (quote-only fallback if a facet layout can't be decoded) | LI.FI (li.quest) picks a different facet per request, but every facet's first parameter is `ILiFi.BridgeData` — decoded the same way LI.FI's own `CalldataVerificationFacet.extractBridgeData` does, checking `receiver`, `destinationChainId`, `sendingAssetId`, `minAmount` against the request. Native `value` checked against `amountIn` (ERC20: must be 0). Charges a documented 0.25% service fee. |
| `debridge.ts` | USDC, ETH | any pair both sides support, both ETH-native-verified for ETH requests | owner-only, **quote-only in practice** | **none** | deBridge's recipient argument is right-padded inside its word, not left-padded — the generic calldata scan never actually matches it (confirmed against the real function with distinct sender/recipient addresses), and deBridge has no declared recipient field to catch the gap the way LI.FI does. Not executable by this package's own rule. Still decodes/cross-checks target, value/fixFee and chain ids to protect the quoted price. Monad addressed as deBridge's internal id `100000030`, not its EVM chain id `143` — confirmed live. |

All three aggregator adapters decode the calldata they are about to return and refuse the quote outright if the
account's address cannot be found among its ABI-encoded words (`src/recipient.ts`) — this is the "decode the
returned calldata and refuse it unless the recipient is the account" rule from the design note, applied before
the owner ever sees the quote, not just before signing it.

**Compliance-screen false positive, worth knowing when testing by hand:** deBridge's compliance check flags the
repeated-digit address `0x1111...1111` as high-risk (`COMPLIANCE_ADDRESS_BLOCKED`); LI.FI rejects both
`0x1111...1111` and `0x2222...2222` with a misleadingly worded `"Zero address is provided"` 400. `0x4444...4444`
is clean on every provider this package calls — used throughout the recorded test fixtures and the live smoke
script.

### Hardening pass: every field from a third-party API is untrusted input

`debridge.ts` pins its target contract to the one address this adapter has actually observed identical on
Ethereum, Base and Monad as the source chain (`0xeF4fB24aD0916217251F553c0596F8Edc630EB66`, checked live 18 Oct
2026) and refuses any other; cross-checks the native `tx.value` it is about to attach against the fee the
response separately declares (`fixFee`) — exactly equal for a USDC-input order, `amountIn + fixFee` plus a small
observed top-up for an ETH-input order — and refuses outside that band, on top of an absolute circuit breaker;
and cross-checks the response's own echoed chain ids against the request. `relay.ts` and `lifi.ts` were not
given the same target allowlist: Relay's and LI.FI's router/diamond address was only confirmed stable for one
origin chain each this round, and guessing it for chains not checked would be worse than not pinning it at all.

`recipient.ts`'s calldata scan (used by all three owner-only adapters) now refuses calldata that is not a whole
number of 32-byte words after the selector — not standard ABI encoding, never scanned for a "lucky" match. It
still cannot tell "the real recipient argument" from "the account's bytes appear somewhere in this call"
without knowing the selector ahead of time, which is exactly why these three routes are owner-only instead of
session-key in the first place (see `src/types.ts`'s `RecipientCheck` doc comment): pinning a selector would
mean maintaining an allowlist of every route an aggregator might ever choose, defeating the point of using one.
The real security boundary for an owner-only route is the owner's own passkey-signed review of the decoded
transaction before signing — a future, UI-side ticket, not this quoting layer.

### Second hardening pass, grounded by two cross-model reviews

An independent review (`xreview`, `codex-auto-review@embi` — the designated fallback seat once the primary
Codex seat here dropped under its 15% floor) found five further issues, checked one by one rather than applied
blind:

- **Valid, fixed:** `cctp.ts` had no upper bound on Circle's quoted fee — only "fee < 100% of the amount" was
  refused. This route is session-key, so an unattended signer trusts its output directly; a malformed or
  compromised `minimumFee` (the review's example: `9999`) would otherwise become calldata burning nearly the
  whole amount. Capped at 50 bps, the same bound (and reasoning) as Across's already-proven one.
- **Valid, fixed:** `debridge.ts`'s chain-id cross-check was lenient when the response omitted a field; every
  real response seen this round echoed both, so it is now required, not merely checked-when-present. Its native
  value/fixFee check could also be defeated by a response that inflated `value` and `fixFee` together,
  consistently — passing because they agreed with each other, not because either was plausible. Fixed with a
  second, chain-scaled cap on `fixFee` alone (0.05 ETH on Ethereum/Base, 20 MON on Monad — 10-50x the one real
  fee observed per chain), independent of the value/fixFee agreement check.
- **Valid, fixed — Relay only:** the recipient check previously scanned Relay's calldata for the account at any
  word. Re-verified live across Ethereum/Base/Monad origin and both ERC20 and native input: Relay's deposit
  target and the recipient's word-0 offset were identical every time. That is now an exact-offset check
  (`calldataPinsRecipientAtWord`) plus a pinned target, the real equivalent of a `UniActionPolicy` EQUAL rule —
  not the fallback scan. LI.FI and deBridge keep the scan: LI.FI's target itself varies by origin chain (see
  below) and its calldata is a deeply nested multicall encoding, not a leading argument; deBridge's offset was
  not checked for the same stability.
- **Valid, fixed — target allowlist generalised:** re-checking LI.FI's target across chains found it is NOT the
  same everywhere — the standard LiFiDiamond (`0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE`) on Ethereum/Base,
  but a different executor (`0x026F252016A7C47CDEf1F05a3Fc9E20C92a49C37`) on Monad. `lifi.ts` now pins a
  per-origin-chain allowlist instead of one address, refusing any chain not in it (this is also why Relay's
  single-constant pin was only adopted after confirming it does NOT vary the same way).
- **Checked and rejected as overstated:** the review's claim that `/suggested-fees` "now requires a bearer API
  key" and "will fail in production" is contradicted by a live, unauthenticated `curl` against it run the same
  day this was checked — `HTTP 200` with a normal answer, no key, no header. `across.ts` was still given
  optional `ACROSS_API_KEY` support (parity with the proven `bridge-out.ts` pattern — a key only raises rate
  limits), but the adapter does not depend on one, and the finding's "will fail" framing does not hold.

Also added: Relay's leading ERC20 `approve` step (when present) is now checked against the pinned deposit
target as spender and `amountIn` as the amount, not merely assumed consistent.

### Third hardening pass: a chain's native asset is a fact, not an assumption; two adapters' recipient checks never actually worked; ranking now prices native cost

A third review (GPT-6/`gpt-6-sol`, `review:pr` at `013b79d`) found four more issues. Three were confirmed by
direct testing before any code changed, and the fourth (Relay's recipient) led to re-testing LI.FI and deBridge
the same way, which surfaced a second, more serious finding the review itself did not name.

- **`chains.ts`: `tokenAddress('ETH', 143)` returned the native pseudo-address unconditionally.** Monad's native
  asset is MON, not ETH — ETH does not exist there natively at all. `ChainConfig` now carries a `nativeAsset`
  field (`'ETH' | 'MON'`), and `tokenAddress('ETH', chainId)` only resolves on a chain confirmed to use ETH as
  its own native asset (Ethereum, Base); it is `undefined` on Monad and on any chain not in the registry at
  all — never assumed. This closes a real gap: before the fix, a request to bridge "ETH" to or from Monad would
  have been treated as supported by Relay/LI.FI/deBridge.

- **Relay's deposit calldata carries no on-chain recipient at all.** Checked directly: a quote requested with a
  DIFFERENT `user` (0x5555...) and `recipient` (0x6666...) showed the deposit calldata's first word is the
  depositor (0x5555...) — the recipient does not appear anywhere in it. Every earlier fixture set `user ===
  recipient === account`, which made "this word is the depositor" and "this word is the recipient"
  indistinguishable; that confound, not a correct check, is what made the earlier version look right. Per the
  project's rule — if the destination recipient cannot be verified, the route is not offered — Relay is now
  quote-only: `recipientCheck: 'none'`, `calldata` and `value` always `undefined`. The decode-and-refuse checks
  on token/amount/native-value it still runs protect the TRUSTWORTHINESS OF THE QUOTED PRICE (so a comparison
  against other adapters isn't built on a mismatched quantity), not the safety of executing it — there is
  nothing here safe to execute.

- **Applying that same distinct-sender/recipient test to LI.FI and deBridge surfaced a second bug the review
  did not name.** LI.FI genuinely carries the recipient (confirmed: querying with `account` set to the real
  recipient succeeds, set to the sender fails, because LI.FI's own declared `action.toAddress` field catches
  the mismatch) — it keeps `recipientCheck: 'decoded-calldata'`. deBridge does not: its recipient argument is
  **right-padded** inside its 32-byte word (`7777...7777000...000`), not left-padded the way a plain ABI address
  argument is, so `calldataPinsRecipient`'s exact-word match never finds it — confirmed by running the actual
  function against real captured calldata, not a loose substring search. Only the sender's (correctly
  left-padded) word ever matched, indistinguishable from a correct recipient match under the same
  same-sender-and-recipient confound that broke Relay. deBridge has no declared recipient field to catch this
  the way LI.FI does, so it is now quote-only too (`recipientCheck: 'none'`, no `calldata`/`value`) — a
  correction beyond what the review literally asked for, but required by its own stated rule once tested.

- **`selector.ts` ranked by raw `amountOut`**, ignoring that a route can also spend the account's native balance
  (`value`) without that showing up in `amountOut` at all. `pricing.ts` (new) converts `value` into the same
  units as `amountOut` so they can be subtracted, using a stated, deliberately conservative (high) price —
  $5,000/ETH, no entry for MON (nothing this round establishes a trustworthy MON/USD price). A quote whose
  native cost cannot be priced this way never outranks one with a known cost, not even a known cost of zero.
  Mid-implementation, a real bug surfaced: `value` is not always pure cost — when the bridged asset IS the
  source chain's native asset (canonical.ts's ETH bridge, `value == amountIn` exactly), the whole principal has
  to move as `value`, and an early version of this fix subtracted all of it, double-counting the principal as
  if it were a fee. `pricing.ts` now only counts the excess of `value` over `amountIn` as a real cost — caught
  by re-running the live smoke script and noticing `canonical-base` had dropped out of first place on the ETH
  direction for no real reason, not by a unit test (one was added afterward, `pricing.test.ts`).

Not done, and why: no selector or adapter tries to price Monad's native asset in USD. Stating a number for an
asset nobody on this ticket has verified a price for would be guessing a fact, which the "don't guess" rule
this package has followed throughout forbids just as much for a price as for a contract address. Any nonzero
native cost on a Monad-sourced quote is instead treated as unpriceable, which is the safe default, not a gap.

### Fourth hardening pass: LI.FI's generic recipient scan removed, replaced with a real `BridgeData` decode

A fourth review (GPT-6/`gpt-6-sol`, `review:pr` at `b7186c6`) found two issues, both on `lifi.ts`'s
`recipientCheck` and native `value`. The first led to removing a whole code path from the package, not just
patching `lifi.ts`.

- **The generic calldata scan (`calldataPinsRecipient`) could not tell "the real recipient argument" from "the
  account's bytes appear somewhere in this call".** It had already made Relay's and deBridge's recipient
  checks into no-ops (third hardening pass, above) and happened not to be wrong for LI.FI only because its own
  declared `action.toAddress` field also agreed — the same shape of risk, not yet triggered. Checked first,
  rather than patched blind: LI.FI's own on-chain `CalldataVerificationFacet.sol` (fetched from
  `raw.githubusercontent.com/lifinance/contracts/main/src/Facets/CalldataVerificationFacet.sol` and
  `.../Interfaces/ILiFi.sol`, 20 Oct 2026) decodes exactly this, generically across every facet, with
  `_extractBridgeData(data) = abi.decode(data[4:], (ILiFi.BridgeData))` — because `BridgeData` is always the
  first parameter of any facet's `startBridgeTokensViaXxx` function, decoding only that struct's type works
  regardless of which bridge/facet LI.FI picked, no facet-specific knowledge needed. Confirmed against four
  real quotes (ERC20 and native input, same-address and distinct sender/recipient): `receiver`,
  `sendingAssetId` and `destinationChainId` decoded exactly as expected every time, including correctly
  distinguishing the real recipient from the sender when they differed. `lifi.ts` now decodes `BridgeData` and
  checks `receiver`, `destinationChainId`, `sendingAssetId` and `minAmount` (bounded: `0 < minAmount <=
  amountIn` and `minAmount >= amountOut` — the bridge step can only take a little more fee after this point,
  never add value) against the request; a facet layout that fails to decode at all (not one this package has
  verified) falls back to quote-only (`recipientCheck: 'none'`), per the project's rule, rather than being
  refused outright or trusted.

  `calldataPinsRecipient` and `assertOwnerOnlyRecipient` were removed from `recipient.ts` entirely — nothing in
  this package uses a generic "is the account anywhere in this calldata" check any more. What remains
  (`wordAt`, `calldataPinsRecipientAtWord`) are exact-position reads only, used at offsets a provider's shape
  was directly confirmed to place a specific field at (`relay.ts`'s token/amount checks), never a scan.

- **`lifi.ts` never checked `transactionRequest.value`** against the request, the same gap Relay's and
  deBridge's value checks closed earlier. Fixed: 0 for an ERC20-input order; `amountIn` (plus a small bounded
  slack, mirroring deBridge's — LI.FI attached exactly `amountIn` with no top-up in every live sample checked)
  for a native-input one.

## What was out of scope for adapters, deliberately

- **Fast-withdrawal third parties** (Brid.gg, Garden, Superbridge) for Base's 5-day L2->L1 delay: third-party
  trust assumptions outside this ticket's "official or verified public API" bar.
- **Superchain interop, EEZ**: not usable infrastructure today (see above).
- **ERC-7683, 7715, 5792, 7484, Rhinestone Warp, Everclear, Eco**: named in the design note's round-1 research as
  unverified and out of scope for that round; still unverified, still out of scope here — a future ticket, not
  this one.
