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
