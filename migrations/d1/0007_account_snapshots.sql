-- Per-account money at a block, from the operator's snapshot loop (otto/mamoru#136). Additive only. Not read by
-- anything yet: phase 2 (a Worker pulling GET /snapshot) writes it; the yield ledger (#129) and the ops filters
-- by environment and chain (#130) build on it.
-- Money columns are raw USDC units (6 decimals) as INTEGER: exact up to 9e9 USDC per account.
-- env is 'prod' | 'beta' | 'test', filled from the accounts table once #130 adds it there; until then 'prod'.

CREATE TABLE account_snapshot_latest (
  chain_id INTEGER NOT NULL,
  address TEXT NOT NULL,              -- the Safe, lowercase 0x
  account_key TEXT NOT NULL,
  env TEXT NOT NULL DEFAULT 'prod',
  block INTEGER NOT NULL,
  read_at TEXT NOT NULL,              -- ISO, operator clock
  deployed INTEGER NOT NULL,          -- 0 | 1
  idle_usdc INTEGER NOT NULL,         -- tokens outside positions, valued in USDC (gas ETH left out)
  lp_usdc INTEGER NOT NULL,           -- principal of the positions
  fees_usdc INTEGER NOT NULL,         -- uncollected fees, valued at the same block
  total_usdc INTEGER NOT NULL,
  positions_json TEXT NOT NULL,       -- [{tokenId, pool, inRange, valueUsdc, fees0, fees1, feesUsdc}], integers as strings
  updated_at TEXT NOT NULL,           -- ISO, Worker clock
  PRIMARY KEY (chain_id, address)
) WITHOUT ROWID;

-- One row per account, chain and UTC day: the day's first and last snapshot. #129 adds what was collected and the
-- gas Mamoru paid; yield of a day = fees_close - fees_open + collected (a harvest moves fees out of "uncollected").
CREATE TABLE account_daily (
  day TEXT NOT NULL,                  -- UTC YYYY-MM-DD
  chain_id INTEGER NOT NULL,
  address TEXT NOT NULL,
  account_key TEXT NOT NULL,
  env TEXT NOT NULL DEFAULT 'prod',
  block_open INTEGER NOT NULL,
  block_close INTEGER NOT NULL,
  total_open_usdc INTEGER NOT NULL,
  total_close_usdc INTEGER NOT NULL,
  idle_close_usdc INTEGER NOT NULL,
  lp_close_usdc INTEGER NOT NULL,
  fees_open_usdc INTEGER NOT NULL,
  fees_close_usdc INTEGER NOT NULL,
  collected_usdc INTEGER,             -- #129: fees collected during the day (harvest, exit), null until it is written
  gas_paid_wei TEXT,                  -- #129: gas Mamoru paid for this account during the day
  PRIMARY KEY (day, chain_id, address)
) WITHOUT ROWID;

CREATE INDEX account_daily_env_chain ON account_daily (env, chain_id, day);
