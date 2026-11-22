# 014 threats and security review points

High stakes: owner funds and owner signatures. Each point names what a reviewer must check in the implementation PRs.

## Monad leg (step A)

| # | Threat | Control | Review check |
|---|---|---|---|
| S1 | The burn mints to someone else | `mintRecipient` = the owner's Base Safe, read by the Worker from its own `accounts` row (same `user_id`, chain 8453, same env), never from the request; domain 6 only | `checkReturnHome` reads `home` from D1 and the builder throws on zero or self |
| S2 | A hook or a caller restriction diverts or blocks the mint | `depositForBurn` (not `WithHook`), `destinationCaller` 0, `maxFee` 0 | builder has no hook path; test decodes the calldata |
| S3 | Operator builds a different tx than it shows | Worker rebuilds with the same builder and compares the SafeTx hash (`BUILD_MISMATCH`) | hash compare covers `to`, `data`, `operation`, nonce, gas fields, refund receiver |
| S4 | Amount under the balance leaves funds behind, or over it reverts | Worker reads the Safe's USDC `balanceOf` on Monad and requires equality with `amountUsdc` | new check; equality at the block read, stale → re-prepare |
| S5 | A session is left on the Monad Safe | removed set = Stop's set ∪ every on-chain enabled id; Worker checks each id is enabled and that the count matches the Safe's `SessionCreated` ids still enabled; read-back after settle | an omitted session must fail the Worker check, not only the read-back |
| S6 | The Safe pays the relayer | no refund in the Safe tx (`gasPrice` 0, no refund receiver); a prepare that would need one is refused (`SPONSOR_UNAVAILABLE`) | built |
| S7 | Delegatecall to an arbitrary target | only MultiSendCallOnly 1.4.1 (pinned address) is delegatecalled; every inner call is a CALL | builder uses `ownerSafeTx` |
| S8a | Step A0 built to send the proceeds elsewhere, or a different trade | Worker rebuilds A0 with `buildMonadSell` and compares the hash; pins Safe, router, tokens, fee, `recipient` = this Safe, `amountIn` = on-chain WMON, MultiSendCallOnly only (RH-03) | each pin wrong → `BUILD_MISMATCH` in SCN-RH-02 |
| S8 | Step A0 sale at a bad price | `minOut` = QuoterV2 quote less 30 bps; the Worker re-quotes on Monad and refuses `minOut` more than 30 bps under its quote, or a quote more than 300 bps under the TWAP value (`MONAD_DEPTH_TOO_LOW`); the summary shows Y and Z | owner path skips the action policy: the Worker check is the only price guard besides the user reading Z |
| S9 | Replay on another chain or Safe | SafeTx hash binds chain id, Safe and nonce | none |
| S10 | Allowance left to TokenMessenger or the router | exact `approve(amount)` consumed by the burn; exact `approve(w)` consumed by `exactInputSingle(amountIn = w)` | builder; a test reads both allowances after the tx |
| S10b | USDC stranded on Monad by a late bridge mint | permanent Base-side fence set under the bridge sender's lock before the Monad prepare; then step A refused while a bridge is `sending`, `burned`, `dropped` or minted-unread (RH-11) | tests: each non-terminal state → `BRIDGE_IN_FLIGHT`; a dropped bridge is not re-signed after a step A prepare |

## Base side

| # | Threat | Control | Review check |
|---|---|---|---|
| S11 | Adopting a forged return report | the home adopts only a burn whose Circle-attested message decodes to: source Monad, destination Base, recipient = this Safe, `messageSender` = this account's remote Safe, Monad USDC, the reported amount | built (b67da3ac); a test with each field wrong |
| S12 | Double count or double mint | one record per burn tx; `usedNonces` on Base | built (aa8abaa4) |
| S13 | The return is placed above the cap | the cap is cross-chain and counts in-flight returns (#355); v8 share caps 25 % | test: return that would push Base over the cap waits |
| S14 | v8 widens a leaked session key's reach | same cap C; USDC/cbBTC gains manage-any at 25 % share, WETH/USDC drops from 35 % to 25 %, bridge-out to Monad removed | spec 010 threat table bound unchanged or lower |
| S15 | Step B's summary and its grants disagree | the renewal summary is generated from the target policy; the hash binds the grants | test that the summary's percentages equal v8's preferences |
| S16 | An account on v8 bridges to Monad | no bridge grant in v8; `base_v8` gate on the remote bridge path | built |

## Owner signing

- **S17 One prompt per hash.** Each WebAuthn assertion's challenge is one SafeTx hash; the app shows that leg's summary
  lines before the prompt and never batches a hash the screen did not show.
- **S18 RP ID unchanged.** Beta and prod passkeys stay scoped to their hostnames.
- **S19 No new signer, module or owner.** Neither leg adds an owner, a module or a fallback handler. A reviewer rejects
  any calldata that touches `addOwnerWithThreshold`, `enableModule`, `setFallbackHandler`, `setGuard` or
  `installModule`.

## Accepted risks

- Circle CCTP: the return relies on Circle's attesters and Monad/Base CCTP contracts, as every bridge since spec 002.
- An owner who never signs keeps USDC on Monad with one growth-only session under the entry pause.
