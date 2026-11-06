# 013 scenarios

None of these needs a fork: they run against a D1 fixture (Miniflare in `bun test`) or the built Worker
(`worker.fetch`), or, where marked, on beta. Each cites requirements from `spec.md`.

| Id | Reqs | Where | Given | When | Then |
|---|---|---|---|---|---|
| STATS-S01 | R2, R3 | worker.fetch + Playwright | no cookies | GET `/stats`, then `/api/stats` | 200 HTML with the menu and the four figures; no `/api/auth` call, no WebAuthn prompt; CTA "Start saving" links to `/` |
| STATS-S02 | R9 | D1 fixture | 5 owners with accounts, Safes, tx hashes in the fixture | GET `/api/stats` | the body contains none of their `account_key`, address, `user_id` or tx hash (string search over the raw JSON) |
| STATS-S03 | R9 | D1 fixture | a day backed by 2 owners, the next by 3 | series built | first point `usd: null, reason: TOO_FEW_ACCOUNTS`; second point has a value and `owners: '3+'` |
| STATS-S04 | R5, R10 | D1 fixture | Base rows from day 1, Monad sleeve rows from day 5 | GET `/api/stats` | `monadFrom` = day 5; TVL of day 6 includes Monad; a chain split is absent when Monad has < 3 owners |
| STATS-S05 | R10 | D1 fixture | no `placed_usdc` anywhere; vault yield not available | GET `/api/stats`, render | volume points `NOT_COUNTED`, page shows "not counted" (no `$0`); earned says "fees only" |
| STATS-S06 | R13 | worker.fetch with a limiter stub | 61 requests in a minute from one IP | GET `/api/stats` | the 61st answers 429 `READ_RATE_LIMITED` with `retry-after: 60`; D1 query count = 1 within the cache window |
| STATS-S07 | R6 | operator unit + D1 fixture | a userOp receipt with `IncreaseLiquidity` (amount0, amount1) and an ERC-4626 `Deposit` (owner = Safe), plus one for another owner | facts read, snapshot prices the pool, Worker writes receipts | `placedUsdc` = priced LP amounts + vault assets of this Safe only; the other owner's deposit is not counted; a stored op with v1 facts is re-read once |
| STATS-S08 | R12 | D1 fixture | a funded test account (`is_test = 1`) and an `unknown` env row | GET `/api/stats` | neither is in any sum or owner count |
| STATS-S09 | R8, R10 | Playwright on `/stats` with fixture API | a series with a gap, a partial today, and "Base only" before day 5 | hover/tap and arrow keys over the chart | tooltip shows the UTC date and value; gap reads its reason; today says "so far"; band "Base only" visible; no motion with `prefers-reduced-motion` |
| STATS-S10 | R14 | worker.fetch | owner A with Base + Monad sleeve; owner B | A's session GETs `/api/accounts/<A>/value-series`, then `<B>`'s | A's series = Σ of A's two accounts per day; B's answers 403/404 like other account reads |
| STATS-S11 | R1, R3 | Playwright | signed-in owner on `/` | menu → Stats → Portfolio | session kept; Portfolio shows the account; without a session `/` shows the cards and the menu |
| STATS-S12 | R15, R16 | Playwright with fixture API | owner with fees and vault yield | open `/` | Earned so far card = LP + vault yield, with its source; Add capital and Withdraw at the top open the existing flows |
| STATS-S13 | R5 | beta, read-only | live D1 | compare `/api/stats` `tvlNow` with Σ `account_snapshot_latest.total_usdc` (prod + beta, no test) | equal to the dollar |
