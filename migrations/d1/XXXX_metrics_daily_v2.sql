-- Daily ops metrics keyed by (day, chain_id, env), replacing the single global row of `metrics_daily` (otto/mamoru#130).
-- Additive only: `metrics_daily` is untouched and stays readable, so nothing that reads it today breaks. Written by
-- mamoru-astro (migrations/0004_experiments.sql's sibling reference copy lives there), one row per group per day.
-- Test accounts (accounts.is_test = 1) are excluded from every group's counts, same as the /ops filters default.

CREATE TABLE metrics_daily_v2 (
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
  relayer_eth REAL NOT NULL,
  eth_usd REAL,
  captured_at TEXT NOT NULL,
  PRIMARY KEY (day, chain_id, env)
) WITHOUT ROWID;

CREATE INDEX metrics_daily_v2_env_day ON metrics_daily_v2 (env, day);
