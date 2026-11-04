-- APY over the capital that worked, measured per snapshot (otto/mamoru#343). Additive only; the coordinator applies it
-- (NOT applied by the pull request that adds it), before the Worker that writes and reads it.
--
-- One row per snapshot and per place the account had money working: an LP position's pool (`pool:WETH/USDC/3000`,
-- summed over the account's positions in it) or a vault (`vault:gtUSDCp`). `value_usd` is its value at that snapshot
-- (USDC base units), `in_range` is 0 for a position out of range (it earns nothing), `dt_s` is the seconds since the
-- account's previous stored snapshot. The reader sums value_usd * dt_s where in_range = 1. dt_s is 0 for the first
-- snapshot of an account and after a gap of more than 25 minutes (those rows only anchor the next one). The writer
-- (apps/mamoru-app/src/api/yield-ledger.ts, behind the `yield_ledger` flag) keeps 31 days.
CREATE TABLE account_worked_samples (
  chain_id INTEGER NOT NULL,
  account_key TEXT NOT NULL,
  read_at TEXT NOT NULL,          -- ISO, the snapshot's readAt
  pool TEXT NOT NULL,             -- registry pool or vault name
  value_usd INTEGER NOT NULL,     -- USDC base units at this snapshot
  in_range INTEGER NOT NULL CHECK (in_range IN (0, 1)),
  dt_s INTEGER NOT NULL,          -- seconds this sample stands for
  PRIMARY KEY (chain_id, account_key, read_at, pool)
) WITHOUT ROWID;
CREATE INDEX account_worked_samples_read ON account_worked_samples (chain_id, account_key, read_at);
