# 011 results: fork e2e (`bun run e2e:depth`)

Base fork, policy `conservador-live-v5` (`conservador-live-v7` cannot boot: a policy with a remote bucket is a renewal
target only), prod depth settings `30,500,5`, signed cap C equal to the deposit. 6 Nov 2026.

| Deposit | Start | Placed (USDC/USDT · USDC/cbBTC · WETH/USDC) | Waiting | Stop returned | Log |
|---|---|---|---|---|---|
| 10,000 | ok, 2 extension approvals | 4,996 · 3,998 · 997 = 9,990 | none | 9,993.32 (99.93 %) | `e2e-depth-10k.log` |
| 30,000 | ok | 14,993 · 11,902 · 2,990 | none | 29,982.23 (99.94 %) | `e2e-depth-30k.log` |
| 60,000 | ok | 29,986 · 23,855 · 5,981 | none | 59,965.58 (99.94 %) | `e2e-depth-60k.log` |
| 100,000 | **refused**: the activation simulation reverts (`execTransaction: execution failed`), nothing sent | — | — | — | `e2e-depth-100k.log` |

Findings:
- **Spending windows do not bind on V3 at C = deposit.** v5's per-day windows are 2–5× each bucket's target
  (stables 5,000 vs 25,000 a day at 10k), so no window wait is predicted or seen; assertion (b) computes the prediction.
- **Depth did not bind up to 60k.** No `DECIDE_WAIT_DEPTH` at 10k, 30k or 60k on this block.
- **Start of an undeployed Safe fails between 66,000 (activates) and 80,000 (refused), deterministic over 4 runs.** At
  80k the first approval step carries one more enter grant (USDC/cbBTC) than at 66k, and that batch reverts inside the
  Safe. The engine sizing is not involved; the activation packing is (operator `fitActivation`, static gas estimate for
  an undeployed Safe). Ticket filed; until fixed, the cap stays at 10,000 (PRD: 1,000,000 only after the 100k proof).
- **Update, 7 Nov:** a fork call trace (PR #328) shows the cause is not gas packing: the policy refuses the Start
  (`BadInit(11)`) because the USDC/USDT pool's signed daily budget at C = 100,000 (250,000) exceeds what the pool's
  band can absorb (~179,000). PR #328 signs each pool's budget under its depth; its own 100k run log is in that PR and lands here when it
  merges. At C = 10,000 the budget is 25,000, well inside the pool.
