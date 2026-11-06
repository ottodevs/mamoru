-- Spec 013 (public Stats), task B5 as amended by A1 (no volume). Additive only; the coordinator numbers and applies it
-- before the Worker that writes it.
--
-- Accrued uncollected LP fees per pool row of each worked sample (raw USDC), so "Earned in the last 24h" can take the
-- accrued level at any sample time. NULL for vault and idle rows, and for rows written before this column.
ALTER TABLE account_worked_samples ADD COLUMN fees_usd INTEGER;

-- CCTP transfers between an account's Safes (operator snapshot `bridges`, spec 013 plan §3.5): the Worker counts their
-- USDC once across chains by comparing burn/mint blocks with the blocks of the reads it stored.
CREATE TABLE yield_ledger_bridges (
  id TEXT PRIMARY KEY,
  direction TEXT NOT NULL CHECK (direction IN ('out', 'home')),
  account_key TEXT NOT NULL,
  env TEXT NOT NULL CHECK (env IN ('prod', 'beta', 'test', 'unknown')),
  amount_usdc INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('sending', 'requested', 'burned', 'minted')),
  burn_block INTEGER,
  burn_at TEXT,
  minted_block INTEGER,
  minted_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX yield_ledger_bridges_account ON yield_ledger_bridges (account_key);
