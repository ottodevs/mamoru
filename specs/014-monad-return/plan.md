# 014 plan: sequence, operator steps, idempotency

Requirements are in `spec.md` (RH-xx). This file says how, at implementation depth, for what is not built yet and how
it fits what is.

## Sequence

```
App (Home card)          Worker                       Monad operator               Base operator
 | Review                 |                             |                            |
 | GET whats-new (base-v8)|---------------------------->|  (via Base: peer status)   |
 | tap Approve on Monad   |                             |                            |
 |-- return-home/prepare->| forward ------------------->| planReturnHome             |
 |                        |<-- safeTx, hash, input -----| (reads Safe, builds)       |
 |                        | checkReturnHome (RH-03)     |                            |
 |<-- summary, hash ------|                             |                            |
 | passkey prompt 1       |                             |                            |
 |-- return-home (sig) -->| forward ------------------->| submit 'stop' -> relayer   |
 |                        |                             | settle: revoke + release   |
 |                        |                             |   home-<tx> state burned   |
 | tap Approve on Base    |                             |                            |
 |-- renew/prepare ------>| forward ----------------------------------------------->| v4Target = v8
 | passkey prompt 2       |                             |                            |
 |-- renew (sig) -------->| forward ----------------------------------------------->| submit renew
 |                        |                             | exposure answer lists the  |
 |                        |                             | owner release  ----------->| ReturnHome: burned
 |                        |                             |                            | attestation matches?
 |                        |                             |                            | receiveMessage (relayer)
 |                        |                             |                            | engine review: place
```

Step A and step B are independent requests. The screen can show step B before step A lands; the Base operator does
not wait for step A to confirm before preparing step B.

## Monad operator (built; changes listed)

- `planReturnHome` (built): refuses `NOT_A_REMOTE`, `STOP_IN_FLIGHT`, `GRANT_CHECK_UNAVAILABLE`, `NOT_DEPLOYED`,
  `MONAD_UNWIND_PENDING`, `NOTHING_TO_STOP`. Holds the Safe tx as a Stop.
- **Change (RH-07):** when WMON above dust is held and the last decision's chain exit code is
  `REMOTE_DEPTH_BELOW_BUDGET`, build the depth-held variant instead of refusing. `ReturnHomeInput` gains
  `sell?: { amountIn, minOut, fee, quote, twapValue }`; `buildReturnHome` adds the approve and `exactInputSingle`
  calls and burns `usdc + minOut`, `minOut` = QuoterV2 quote less 30 bps. Still refused if a position is open. When the
  quote is over 300 bps under the TWAP value, `MONAD_DEPTH_TOO_LOW` and the plain path keeps the growth-only session
  (`removeIds` empty) so the chain exit can sell later.
- **Change (RH-11):** refuse `BRIDGE_IN_FLIGHT` while any Base → Monad `BridgeBurn` for the account is `sending`,
  `burned` or `dropped` (a dropped one can be signed again), or `minted` without the mint read on the Safe; only
  `failed` (receipt-proven revert) and a read mint are terminal. The Base operator, from the first `return-home`
  prepare for its remote (held, signed or confirmed), refuses to sign, re-sign or broadcast any bridge to Monad for
  the account, and drops held unsent ones; a userOp already broadcast is followed to its receipt and mint, and step A
  waits for it.
- Settle (built): the confirmed tx records the release `home-<tx>` (state `burned`, `owner.home`), marks the account
  inactive, records the revokes.
- **Change:** after settle, read back `isSessionEnabled` for every id in the input and every id `sessionCreatedIds`
  finds. Any left: alert and offer a revoke-only step A (the builder already takes `amountUsdc` 0).

## Base operator

- **Return leg (built):** `ReturnHome` takes the reported owner release to one of the account's homes as burned (sender
  = the remote Safe), fetches Circle's attestation for the burn tx, checks the decoded message (source domain Monad,
  destination 6, `mintRecipient` = this Safe, amount, `messageSender` = the remote Safe, burn token Monad USDC, `destinationCaller` 0;
  hook data is not read and cannot change the recipient), and calls `receiveMessage` from the relayer. Counted in flight until the mint is read on chain.
- **Mirror (to build):** the `WhatsNew` view with `policy: 'base-v8'`, `signatures` 1 or 2, `steps` in order
  `[monad (return-home), base (renew to v8)]`, `currentStep` from the Monad operator's status (a new
  `return-home/status` on the peer, like `migrate-v4/status`) and from the Base renewal journal.
- **Placement after the return lands (RH-05):** no new code path. The minted USDC is idle on the Base Safe. The next
  engine review on v8 sees each bucket's gap against its target and proposes entries within:
  - the account's signed cap, which already counts the Monad value and in-flight returns (#355), so the return never
    pushes Base over the cap;
  - each bucket's share cap (25 % USDC/cbBTC, 25 % WETH/USDC) and the session's per-window budget;
  - the depth sizing (`DECIDE_WAIT_DEPTH` waits rather than paying impact).
  USDC/cbBTC is entered as today's V3 entries: swap half to cbBTC within the band, mint in range. A v7 account that
  returned before step B keeps the USDC idle until v8 is signed (the v7 Monad bucket is entry-paused; v7's cbBTC bucket
  is exit only).
- **Harvests (#413):** harvested yield goes to a savings layer in the Stable vault, outside the bucket targets. The
  placement above counts only principal (the returned USDC and what the account already holds); it never assumes a
  harvest re-enters a pool, and the savings layer is not part of any bucket's gap or share cap.
- **WETH/USDC drift:** from v7's 35 % to v8's 25 % by the usual reduce, one op per review, past `DRIFT_BPS`.

## Idempotency and resumption

| Step | Why repeating it is safe |
|---|---|
| prepare (either leg) | Pure: builds from on-chain reads and the Safe nonce. A changed nonce or balance makes the held tx stale (`RETURN_HOME_STALE`, `ONE_AUTH_STALE`): prepare again. |
| submit | One Safe nonce: a second submit of the same signature reverts `GS026`/nonce and is reported as already done. Held by `prepareId`. |
| burn record | Id from the burn tx hash (`returnReleaseId`): one record per burn; a re-report never overwrites an entry (aa8abaa4). |
| adopt on Base | Only once Circle's attested message matches; re-reading the same report adds nothing. |
| mint | `receiveMessage` checks `usedNonces`: a second relay reverts harmlessly. ReturnHome reads `usedNonces` before sending, and treats "already used" as minted when the Safe's balance shows it. |
| placement | Level based (targets vs holdings each review): a restart re-plans from chain state. |
| step B | The renewal is one Safe tx by nonce; v8 grants are salted by the policy hash, so a repeat enable is refused. |

## Stuck cases

| Case | Detection | Action |
|---|---|---|
| Depth-held Safe | prepare reads WMON > dust and the chain exit code | depth-held variant (RH-07) |
| Circle attestation API down or slow | in flight > 2 h | alert; keep polling with backoff; anyone can mint once it is attested |
| Mint reverts 3 times | ReturnHome counter | alert; message stays mintable to the same recipient |
| Base → Monad bridge not terminal at prepare | Base bridge journal states | `BRIDGE_IN_FLIGHT`: step A waits for the mint (or the proven revert), then burns it with the rest (RH-11) |
| Depth-held sale refused (`MONAD_DEPTH_TOO_LOW`) or reverts on price | Worker quote check / receipt | plain path: USDC home now, session kept for the chain exit, second step A later; a revert is atomic and re-prepared |
| USDC reaches the Monad Safe after step A anyway (fault case under RH-11) | Monad exposure > dust with no session | alert; Home offers step A again as a send-only tx (one more prompt) |
| Session found after settle | read-back | alert + revoke-only step A |
| Step B reverts (enable's depth check, #410, on a Base pool) | simulation at prepare | prepare refuses with the policy's reason; v8 caps re-sized (Base pools are far deeper than a 25 % share of 10,000 today, see SCN-RH-07) |
