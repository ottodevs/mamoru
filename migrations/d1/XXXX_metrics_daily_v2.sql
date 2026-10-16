-- Daily ops metrics keyed by (day, chain_id, env), replacing the single global row of `metrics_daily` (otto/mamoru#130).
-- Additive only: `metrics_daily` is untouched and stays readable, so nothing that reads it today breaks. Written by
-- mamoru-astro (migrations/0004_experiments.sql's sibling reference copy lives there), one row per group per day.
-- Test accounts (accounts.is_test = 1) are excluded from every group's counts, same as the /ops filters default.
--
-- `relayer_eth` and `eth_usd` are NOT here: the relayer is one wallet shared by every env on a chain, and the
-- ETH/USD price is one number for the whole day, neither of them scoped to prod vs. beta. Storing either on
-- every (day, chain_id, env) row would make it a silent trap: any later `SUM(relayer_eth)` or
-- `SUM(eth_usd * x)` across env or across a `GROUP BY day` would double (or N-) count a value that was never
-- meant to be added to itself. They live once per (day, chain_id) in metrics_daily_chain below instead.

CREATE TABLE IF NOT EXISTS metrics_daily_v2 (
  day TEXT NOT NULL,            -- UTC YYYY-MM-DD
  chain_id INTEGER NOT NULL,
  env TEXT NOT NULL CHECK (env IN ('prod', 'beta')),
  users INTEGER NOT NULL,
  accounts INTEGER NOT NULL,
  funded_accounts INTEGER NOT NULL,
  active_accounts INTEGER NOT NULL,  -- accounts holding >=1 LP position
  dau INTEGER NOT NULL,
  tvl_usd REAL NOT NULL,
  idle_usdc_usd REAL NOT NULL,
  lp_usd REAL NOT NULL,
  positions INTEGER NOT NULL,
  in_range INTEGER NOT NULL,
  captured_at TEXT NOT NULL,
  PRIMARY KEY (day, chain_id, env)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS metrics_daily_v2_env_day ON metrics_daily_v2 (env, day);

-- The chain-level sibling: one row per (day, chain_id), never per env, so a chain-wide value is stored exactly
-- once and nothing that reads it can double count it by summing or grouping across env.
CREATE TABLE IF NOT EXISTS metrics_daily_chain (
  day TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  relayer_eth REAL NOT NULL,
  eth_usd REAL,
  captured_at TEXT NOT NULL,
  PRIMARY KEY (day, chain_id)
) WITHOUT ROWID;
