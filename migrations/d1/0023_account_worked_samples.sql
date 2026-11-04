-- APY over the capital that worked, measured per snapshot (otto/mamoru#343). Additive only; the coordinator applies it
-- (NOT applied by the pull request that adds it), before the Worker that writes and reads it.
--
-- Samples only. One row per snapshot and per place the account had money working: an LP position's pool
-- (`pool:WETH/USDC/3000`, summed over the account's positions in it) or a vault (`vault:gtUSDCp`). `value_usd` is its
-- value at that snapshot (USDC base units), `in_range` is 0 for a position out of range (it earns nothing). An
-- account with nothing working still writes one row, pool 'idle' (value = idle USDC, in_range 0, never counted), so
-- every snapshot seen leaves its time. The Worker writes all rows of one account's snapshot in one batch, ON CONFLICT
-- DO NOTHING: the same snapshot twice, or by the beta and the prod Worker, is written once; a failed batch leaves
-- nothing. No interval is stored: the reader gives each distinct t_s of an account the interval since the previous
-- distinct one (none after a gap of more than 25 min) and clips it to its window. The writer
-- (apps/mamoru-app/src/api/yield-ledger.ts, behind the `yield_ledger` flag) keeps 31 days.
CREATE TABLE account_worked_samples (
  chain_id INTEGER NOT NULL,
  account_key TEXT NOT NULL,
  read_at TEXT NOT NULL,          -- ISO, the snapshot's readAt
  t_s INTEGER NOT NULL,           -- the same instant, unix seconds
  pool TEXT NOT NULL,             -- registry pool or vault name, or 'idle'
  value_usd INTEGER NOT NULL,     -- USDC base units at this snapshot
  in_range INTEGER NOT NULL CHECK (in_range IN (0, 1)),
  PRIMARY KEY (chain_id, account_key, read_at, pool)
) WITHOUT ROWID;
CREATE INDEX account_worked_samples_t ON account_worked_samples (chain_id, account_key, t_s);
