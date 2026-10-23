-- Sleeves per chain (otto/mamoru#64, #67): an owner holds one account per chain, the Base one and, on beta behind
-- the `monad_sleeves` ops flag, one on Monad (143). Additive only, numbered by the coordinator at merge, NOT applied
-- by the pull request that adds it. Apply by hand before the Worker that writes account_activity.chain_id:
--   bunx wrangler d1 execute mamoru --remote --file migrations/d1/NNNN_chain_keyed_sleeves.sql
--
-- What "keyed by chain" means here, table by table, and why no primary key is rebuilt:
--   accounts             account_key is one row on one chain. (chain_id, address) and (chain_id, passkey_credential_id)
--                        are already unique (0001, 0005). Added below: at most one sleeve per owner on any chain other
--                        than Base, enforced by the database. Base is left out of that index on purpose: rows written
--                        before this file are not checked for duplicates per owner, and an index that could fail on
--                        live data is not additive.
--   proj_account_state   keyed by account_key, which names one chain; chain_id is already a column. Added below: the
--                        index the engine's per-chain reads (deployedProjections) walk.
--   account_activity     gains chain_id, backfilled from accounts. Its key stays (account_key, day): rebuilding it to
--                        (account_key, chain_id, day) is not additive, and the previous Worker's
--                        ON CONFLICT(account_key, day) must keep working against this schema. Since account_key already
--                        names one chain, the old key is the same key.
--   positions, metrics   already chain-keyed: account_snapshot_latest (chain_id, address), account_daily and the
--                        yield ledger tables (day/chain_id/...), metrics_daily_v2 (day, chain_id, env).
--
-- Lossless: every existing row keeps every column. The DEFAULT is Base because every account that exists before this
-- file is on Base (the app has only ever onboarded CHAIN_ID 8453); the UPDATE then copies the real chain of each row's
-- account anyway, so the default only stands for an activity row whose account is gone.

ALTER TABLE account_activity ADD COLUMN chain_id INTEGER NOT NULL DEFAULT 8453;

UPDATE account_activity
SET chain_id = (SELECT a.chain_id FROM accounts a WHERE a.account_key = account_activity.account_key)
WHERE account_key IN (SELECT account_key FROM accounts);

CREATE INDEX IF NOT EXISTS account_activity_chain_day ON account_activity (chain_id, day);

CREATE UNIQUE INDEX IF NOT EXISTS accounts_user_sleeve ON accounts (user_id, chain_id) WHERE chain_id <> 8453;

CREATE INDEX IF NOT EXISTS proj_account_state_chain ON proj_account_state (chain_id, deployed, block);
