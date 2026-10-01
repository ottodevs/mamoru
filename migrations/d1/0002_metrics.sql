-- Account activity + daily metrics snapshot tables for the ops dashboard (DAU + history). Additive only.

CREATE TABLE account_activity (
  account_key TEXT NOT NULL,
  day TEXT NOT NULL,            -- UTC YYYY-MM-DD
  hits INTEGER NOT NULL DEFAULT 1,
  first_at TEXT NOT NULL,       -- ISO
  last_at TEXT NOT NULL,        -- ISO
  PRIMARY KEY (account_key, day)
);

CREATE TABLE metrics_daily (
  day TEXT PRIMARY KEY,         -- UTC YYYY-MM-DD
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
  captured_at TEXT NOT NULL
);
