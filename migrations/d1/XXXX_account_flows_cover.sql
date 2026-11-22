-- What the operator vouches of an account's external USDC flows on one chain (otto/mamoru#438), so the Portfolio's net
-- deposited can be called complete. Additive only; the coordinator numbers it and applies it after XXXX_account_flows
-- and before the Worker that writes and reads it.
--
-- One row per chain and account, replaced on every snapshot pull (apps/mamoru-operator/src/flow-cover.ts sends its
-- current word whole): a reason that clears is gone at the next pull, never pinned.
-- from_block: every incoming USDC transfer to the Safe from this block on is in account_flows (or is a mint below).
-- through_block: the snapshot block the operator vouched through; NULL when something arrived that is not recorded
--   yet. The reader requires it at or past the latest read of the account (account_snapshot_latest.block), so a
--   cover the operator stopped sending, or a pull whose flows failed to write, is never taken as current.
-- open_json: JSON array of what the operator cannot vouch for right now ('deposits-cap', 'out:<opId>', ...); '[]' none.
-- mints_json: JSON [{block, t, usdc}] of USDC minted to the Safe (CCTP); the reader matches each with a transfer
--   between the owner's own Safes (yield_ledger_bridges) and counts it in that chain's first-day check.
CREATE TABLE account_flow_cover (
  chain_id INTEGER NOT NULL,
  account_key TEXT NOT NULL,
  from_block INTEGER NOT NULL,
  through_block INTEGER,
  open_json TEXT NOT NULL,
  mints_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (chain_id, account_key)
) WITHOUT ROWID;
