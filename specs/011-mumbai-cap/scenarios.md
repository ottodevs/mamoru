# 011 scenarios

Each scenario cites its requirements. Evidence goes to `specs/011-mumbai-cap/results/` with sha, fork block and date.

| Id | Reqs | Kind | Given | When | Then (expected codes / evidence) |
|---|---|---|---|---|---|
| SCN-CAP-01 | R1 | unit (`release:check`) | D1 with a prod version `capUsdc 10000`, a beta version 500, no override | app reads funding without the operator | `capUsdc` = 10,000,000,000 base units, `capKnown` true; canary naming the account wins; override wins over both; null cap → 100 |
| SCN-CAP-02 | R2 | unit (`release:check`) | real Base pool depth fixture (block 53823027), prod depth 30/500/5 | backtest places 10k and 100k | 10k: nearly all placed; 100k: ~22.5k `DECIDE_WAIT_DEPTH` on stables; Stop returns ≥ deposit − 7 bps |
| SCN-CAP-03 | R2 | fork e2e | anvil fork of Base, operator with prod settings, `conservador-live-v7`, cap 1,000,000 | 10,000 USDC deposited, Start | Start not refused by size; placed by depth; log lines `waited code=… usdc=…` (including 24 h window if hit); Stop returns ≥ 99.9 %. Log `e2e-depth-10k.log` |
| SCN-CAP-04 | R2 | fork e2e | as SCN-CAP-03 | 100,000 USDC | same checks; waiting amounts per code logged. Log `e2e-depth-100k.log` |
| SCN-CAP-05 | R3 | beta, manual | beta account signed at C = 1,000, beta settings at 10,000 | owner opens the app | renewal offered (`capRaise` 10,000 / 1,000); after one approval funding `capUsdc` = 10,000. Tx link in `results/` |
| SCN-CAP-06 | R5 | unit (decide) | v7 account, sleeve ready, `perCall` 200, `amountLeft` 120, gap 400 | allocate | `bridge_out` 120; with `amountLeft` < `entryMin` → no proposal, waiting `DECIDE_WAIT_BRIDGE_LIMIT`; V4 (no fields) → `min(gap, free)` as today |
| SCN-CAP-07 | R5 | unit (operator) | journal with 2 burned bridge-outs (150 + 230) since `validAfter`, total 500 | `bridgeLeft` | 120; a move in `sending` counts; moves before `validAfter` do not |
| SCN-CAP-08 | R6 | unit (web) | `engine.waiting` with codes and amounts | idle line renders | one phrase for the largest waiting amount, link to `docs/waiting.md#anchor`; unknown codes → no phrase |
| SCN-CAP-09 | R6 | unit (operator) | last entry reverted on a window/budget denial, window not moved | next review | waiting `DECIDE_WAIT_DAILY_LIMIT` with the amount; cleared when the window frees |
| SCN-CAP-10 | R4 | ops read | Ot wrote the versions | D1 read + `/metrics` | beta and prod rows with cap 10000; `capRefused` empty |
| SCN-CAP-11 | R3, R4 | prod | a real account renewed | deposit > 1,000 | placed or waiting with a code; tx links |
