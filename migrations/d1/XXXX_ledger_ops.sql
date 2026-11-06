-- Spec 013 (public Stats), task B5. Additive only; the coordinator numbers and applies it before the Worker that writes it.
--
-- yield_ledger_ops: one row per engine op that placed capital (liquidity added to a position, or a vault deposit),
-- from the operator's receipt facts (`receipts[].ops`, layout 3). `placed_usdc` is priced at the op's own block;
-- NULL while unpriced (`priced = 0`): a day with any unpriced op is `partial` in Stats' volume, never a short sum.
-- Volume only: collected fees live in yield_ledger_income (spec 012).
CREATE TABLE yield_ledger_ops (
  chain_id INTEGER NOT NULL,
  op_id TEXT NOT NULL,            -- the op's transaction hash, lowercase
  account_key TEXT NOT NULL,
  env TEXT NOT NULL CHECK (env IN ('prod', 'beta', 'test', 'unknown')),
  t_s INTEGER NOT NULL,           -- block time, unix seconds
  placed_usdc INTEGER,            -- raw USDC; NULL = not priced yet
  priced INTEGER NOT NULL CHECK (priced IN (0, 1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (chain_id, op_id)
) WITHOUT ROWID;
CREATE INDEX yield_ledger_ops_t ON yield_ledger_ops (t_s);

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
