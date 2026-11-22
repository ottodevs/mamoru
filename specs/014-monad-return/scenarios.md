# 014 scenarios

Each scenario cites its requirements. Evidence goes to `specs/014-monad-return/results/` with sha, fork block and date.

| Id | Reqs | Kind | Given | When | Then |
|---|---|---|---|---|---|
| SCN-RH-01 | RH-02, RH-03 | unit (`release:check`) | `ReturnHomeInput` for a Monad Safe, home = the owner's Base Safe | Worker rebuilds | same hash → passed on; each of: home ≠ the row's Base Safe, other env, Safe ≠ row, chain 8453, `amountUsdc` ≠ on-chain balance, an enabled session missing from `removeIds`, a hook, `destinationCaller` ≠ 0 → `BUILD_MISMATCH`, nothing signed |
| SCN-RH-02 | RH-07 | unit | Safe with 0 positions, 120 WMON, 300 USDC, chain exit code `REMOTE_DEPTH_BELOW_BUDGET` | prepare | depth-held variant: approve + `exactOutputSingle(amountOut = q = TWAP − 80 bps, amountInMaximum = 120 WMON)` + burn `300 + q`; after the tx USDC is 0 and the WMON left is worth ≤ 80 bps of the sale; Worker refuses a `q` below its own TWAP floor; with an open position → `MONAD_UNWIND_PENDING` |
| SCN-RH-03 | RH-05, RH-06 | unit (operator) | a confirmed step A receipt | settle, restart, re-report | one `home-<tx>` release, `burned`; restart keeps it; a second report of the same tx adds nothing; Base adopts it only with a matching attested message; a mismatch in any field is not adopted |
| SCN-RH-04 | RH-05 | unit (operator) | minted return of 450 on a v8 account at cap 10,000 with 2,439 on Base | engine reviews | proposals fill USDC/cbBTC toward 25 % within the share cap and the window budget; nothing above the cap; WETH/USDC reduced toward 25 % one op per review |
| SCN-RH-05 | RH-06 | unit (operator) | step A done, step B not | review on v7 | the returned USDC stays idle; no bridge to Monad proposed; Home offers step B |
| SCN-RH-06 | RH-01, RH-10 | unit (operator) | v7 account with a Monad Safe | `whats-new` | `policy: 'base-v8'`, `signatures: 2`, steps `[monad, base]`, summaries equal to the prepares' lines; v2 account → one step |
| SCN-RH-07 | RH-04 | fork e2e (Base) | Base fork, v7 account at C = 10,000 with v7 positions | step B signed with a test passkey | renewal lands; v8 grants enabled (the enable's depth check passes for USDC/cbBTC and WETH/USDC at 25 % of 10,000); bridge-out grant revoked. Log `e2e-v8-move.log` |
| SCN-RH-08 | RH-02, RH-05 | fork e2e (two forks) | Monad fork with a v7 remote Safe holding USDC and one session; Base fork with the home, a local attester enabled on MessageTransmitterV2 (impersonated attester manager, as `e2e-two-chain.ts`) | step A signed with a test passkey; the test signs the burn message with the local attester | Monad: no session enabled, USDC 0, MON unchanged; Base: release adopted, `receiveMessage` mints to the home; engine proposes the USDC/cbBTC entry. Log `e2e-return-home.log` |
| SCN-RH-09 | RH-07 | fork e2e (Monad) | Monad fork, Safe holding WMON, session budget above the pool depth | step A (depth-held variant) | swap returns exactly `q`; burn of `usdc + q`; Safe USDC 0; WMON residual within the stated bound |
| SCN-RH-11 | RH-11 | unit (operator) | a Base → Monad bridge burned, not yet minted on the Safe | step A prepare; Base review after a step A prepare | `BRIDGE_IN_FLIGHT`, nothing held; after the mint the prepare burns the minted USDC too; the Base engine proposes no bridge to Monad once a step A prepare exists |
| SCN-RH-10 | all | real account (beta, then one prod) | beta account b54dda3a in the `base_v8` scope, then one prod account whose owner agrees | owner signs both steps in the app | tx links of step A, Circle attestation, mint on Base, step B, the first USDC/cbBTC entry; Monad Safe reads no session; totals never dip. Evidence `results/real-<account>.md` |

## The fork e2e limitation

anvil 1.7.1 deadlocks in long Base forks: after the engine's first swap (#374) and at about fork + 535-590 blocks
(#424). Neither has a fix. So:

- SCN-RH-07 to 09 run on short forks: each fork lives under 400 blocks, the engine runs one review, and the test
  asserts on the proposal and on the first op's receipt, not on a full placement.
- Two separate forks (Monad, Base) instead of one two-chain run; the attested message is carried between them by the
  test.
- A run that times out with the deadlock signature (no block for 60 s, anvil threads in futex wait) is retried once and
  reported as `E2E_TIMEOUT_S`, never as a pass.
- The full path (placement over several reviews, the WETH/USDC reduce) is proved by unit scenarios SCN-RH-03 to 06 and
  by the real account (SCN-RH-10). The ticket is done only after SCN-RH-10.
