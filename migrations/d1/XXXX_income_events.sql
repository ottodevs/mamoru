-- Income as events, for "earned" (spec 012 HRV-R5, R9; otto/mamoru#107). Additive only; the coordinator numbers it and
-- applies it (NOT applied by the pull request that adds it), before the Worker that writes and reads it.
--
-- yield_ledger_income: one row per income event, never per day, so a rolling 24 h figure and a lifetime total are
-- both sums over rows (apps/mamoru-app/src/api/earned.ts).
-- - 'harvest' / 're-range': one Uniswap Collect log of an engine or owner op (event_id '<txHash>:<logIndex>', t_s its
--   block time), from the operator's receipt facts. A row is never overwritten: a later pull only fills a null usd.
-- - 'vault-yield': what the explained shares of one vault earned between two samples (event_id
--   'vault:<chainId>:<accountKey>:<vault>:<t_s>', interval (from_s, t_s]).
-- - 'backfill': income from before per-event detail: one row per account and day for the collected fees that day's
--   receipts hold above its events ('backfill:<chainId>:<accountKey>:<day>', recomputed each pull), and one per
--   vault at its first sample (the explained shares' value minus their net deposits). Counted in totals, never in 24 h.
-- usd is raw USDC (6 decimals); null = not counted (unpriced, or shares not explained).
CREATE TABLE yield_ledger_income (
  event_id TEXT PRIMARY KEY,
  chain_id INTEGER NOT NULL,
  account_key TEXT NOT NULL,
  env TEXT NOT NULL CHECK (env IN ('prod', 'beta', 'test', 'unknown')),
  source TEXT NOT NULL CHECK (source IN ('harvest', 're-range', 'vault-yield', 'backfill')),
  t_s INTEGER NOT NULL,
  from_s INTEGER,
  usd INTEGER,
  updated_at TEXT NOT NULL
);
CREATE INDEX yield_ledger_income_t ON yield_ledger_income (t_s);
CREATE INDEX yield_ledger_income_account ON yield_ledger_income (chain_id, account_key, t_s);

-- One row per snapshot pull and vault the account holds (or held at the previous sample). explained_shares: the shares
-- the account's own vault flows explain (deposits − withdraws); null while a receipt is unread. explained = 1 when
-- they are the whole holding (±1 wei). The reader takes the latest row per vault as the previous sample.
CREATE TABLE yield_ledger_vault_samples (
  chain_id INTEGER NOT NULL,
  account_key TEXT NOT NULL,
  vault TEXT NOT NULL,
  t_s INTEGER NOT NULL,
  shares TEXT NOT NULL,
  value_usdc INTEGER NOT NULL,
  explained_shares TEXT,
  explained INTEGER NOT NULL CHECK (explained IN (0, 1)),
  PRIMARY KEY (chain_id, account_key, vault, t_s)
) WITHOUT ROWID;
