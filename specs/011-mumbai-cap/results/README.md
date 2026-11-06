# 011 results: fork e2e (`bun run e2e:depth`)

Base fork, policy `conservador-live-v5` (`conservador-live-v7` cannot boot: a policy with a remote bucket is a renewal
target only), prod depth settings `30,500,5`, signed cap C equal to the deposit. 6 Nov 2026.

| Deposit | Start | Placed (USDC/USDT · USDC/cbBTC · WETH/USDC) | Waiting | Stop returned | Log |
|---|---|---|---|---|---|
| 10,000 | ok, 2 extension approvals | 4,996 · 3,998 · 997 = 9,990 | none | 9,993.32 (99.93 %) | `e2e-depth-10k.log` |
| 30,000 | ok | 14,993 · 11,902 · 2,990 | none | 29,982.23 (99.94 %) | `e2e-depth-30k.log` |
| 60,000 | ok | 29,986 · 23,855 · 5,981 | none | 59,965.58 (99.94 %) | `e2e-depth-60k.log` |
| 100,000 | ok after #378 (USDC/USDT daily budget signed at 80 % of its band depth), 2 extension approvals | 49,989 · 39,984 · 9,969 = 99,942 | none | 99,943.30 (99.94 %) | `e2e-depth-100k.log` |

Findings:
- **Spending windows do not bind on V3 at C = deposit.** v5's per-day windows are 2–5× each bucket's target
  (stables 5,000 vs 25,000 a day at 10k), so no window wait is predicted or seen; assertion (b) computes the prediction.
- **Depth did not bind up to 60k.** No `DECIDE_WAIT_DEPTH` at 10k, 30k or 60k on this block.
- **Start failed between 66,000 and 80,000 until #378.** Root cause (trace on the fork): the USDC/USDT Init's
  `perWindow` (the daily budget, from the cap formula) was above what MamoruActionPolicy's depth check reads in the
  pool's 10-tick band, so `initializeWithMultiplexer` reverted `BadInit(11)` (LeftClaw M-5) inside the Safe (GS013).
  At 100k the formula asks 250,000 USDC a day; the band held 180,279. Fix: the operator reads the same depth before the
  owner signs (`@mamoru/uniswap-v3/policy-depth`, a read-for-read port of `_depthIn`) and signs `perWindow` at 80 % of
  it; a pool already configured at the generation keeps its on-chain values. Gas was not the cause.
