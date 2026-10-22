-- otto/mamoru#129 (phase 2): per-day receipts (gas paid, fees collected) stored independently of snapshot rows.
-- otto/mamoru#129 (phase 2): fees each position paid to its Safe per UTC day, from the operator's receipts
-- (apps/mamoru-operator/src/yield-receipts.ts), kept apart from yield_ledger_position_daily. That table only has a
-- row for a day the snapshot saw the position; a rerange collects and burns the old NFT, so on its last day the
-- position may have no row there and its collected fees would have nowhere to go. This table never depends on a
-- snapshot: one row per token id and day an op collected from it, written with the day's full totals (idempotent).
-- collected_usd is null while the operator could not price the day yet; a later write fills it.
CREATE TABLE yield_ledger_position_collected (
  day TEXT NOT NULL,                  -- UTC YYYY-MM-DD of the op's block
  chain_id INTEGER NOT NULL,
  token_id INTEGER NOT NULL,
  account_key TEXT NOT NULL,
  address TEXT NOT NULL,
  env TEXT NOT NULL CHECK (env IN ('prod', 'beta', 'test', 'unknown')),
  collected0 TEXT NOT NULL,
  collected1 TEXT NOT NULL,
  collected_usd INTEGER,
  updated_at TEXT NOT NULL,           -- ISO, Worker clock
  PRIMARY KEY (day, chain_id, token_id)
) WITHOUT ROWID;

CREATE INDEX yield_ledger_position_collected_account ON yield_ledger_position_collected (chain_id, account_key, day);

-- The same per-day receipts at account level, also independent of a snapshot row: account_daily only has a row
-- for a day a snapshot read the Safe, and an account stopped right after an op may have none. loadYieldLedger
-- reads collected and gas from here. `digest` is the SHA-256 of the day as the operator served it: the Worker
-- rewrites a day only when it changed, so the operator can serve the whole history every pull without an age cutoff.
CREATE TABLE yield_ledger_account_receipts (
  day TEXT NOT NULL,                  -- UTC YYYY-MM-DD of the ops' blocks
  chain_id INTEGER NOT NULL,
  address TEXT NOT NULL,
  account_key TEXT NOT NULL,
  env TEXT NOT NULL CHECK (env IN ('prod', 'beta', 'test', 'unknown')),
  gas_paid_wei TEXT NOT NULL,
  collected_usdc INTEGER,             -- null while a fee of the day is unpriced
  digest TEXT NOT NULL,
  updated_at TEXT NOT NULL,           -- ISO, Worker clock
  PRIMARY KEY (day, chain_id, address)
) WITHOUT ROWID;

CREATE INDEX yield_ledger_account_receipts_account ON yield_ledger_account_receipts (chain_id, account_key, day);
