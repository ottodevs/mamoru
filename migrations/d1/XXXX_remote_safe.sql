-- One approval (otto/mamoru#251): the account's Safe on another chain is no longer the Base address deployed again.
-- It has its own address, fixed by the owner's keys and the sessions committed in its setup (packages/account/remote),
-- and `remote_json` holds the RemoteSpec that gives that address. Additive column; numbered by the coordinator at merge,
-- NOT applied by the pull request that adds it. Apply by hand before the Worker that reads it.
ALTER TABLE accounts ADD COLUMN remote_json TEXT;

-- The rows the old POST /api/sleeves wrote: a chain <> Base account at the SAME address as its owner's Base Safe, and only
-- those. Checked on Monad on 2026-10-31 before this migration: the two such rows (0x99aC…c01C, 0x98Af…3777) have no code
-- and 0 USDC (never deployed, never funded), and that address is not the owner's remote Safe, so they go. Any other row
-- off Base is left as it is. The accounts_user_sleeve partial index
-- (0017, one sleeve per owner off Base) stays: the Worker inserts the real row when the Base operator reports it.
-- Dependents first, by account_key, so nothing keeps pointing at a key that no longer exists: proj_account_state has a
-- foreign key to accounts; the others (0002, 0009, 0010, 0015, 0016) are keyed by account_key without one.
-- engine_settings_versions.account_keys_json only lists keys to which a version applied and is left as it is.
DELETE FROM proj_account_state WHERE account_key IN (SELECT s.account_key FROM accounts s JOIN accounts b ON b.user_id = s.user_id AND b.chain_id = 8453 AND lower(b.address) = lower(s.address) WHERE s.chain_id <> 8453 AND s.remote_json IS NULL);
DELETE FROM account_activity WHERE account_key IN (SELECT s.account_key FROM accounts s JOIN accounts b ON b.user_id = s.user_id AND b.chain_id = 8453 AND lower(b.address) = lower(s.address) WHERE s.chain_id <> 8453 AND s.remote_json IS NULL);
DELETE FROM account_snapshot_latest WHERE account_key IN (SELECT s.account_key FROM accounts s JOIN accounts b ON b.user_id = s.user_id AND b.chain_id = 8453 AND lower(b.address) = lower(s.address) WHERE s.chain_id <> 8453 AND s.remote_json IS NULL);
DELETE FROM account_daily WHERE account_key IN (SELECT s.account_key FROM accounts s JOIN accounts b ON b.user_id = s.user_id AND b.chain_id = 8453 AND lower(b.address) = lower(s.address) WHERE s.chain_id <> 8453 AND s.remote_json IS NULL);
DELETE FROM yield_ledger_position_entry WHERE account_key IN (SELECT s.account_key FROM accounts s JOIN accounts b ON b.user_id = s.user_id AND b.chain_id = 8453 AND lower(b.address) = lower(s.address) WHERE s.chain_id <> 8453 AND s.remote_json IS NULL);
DELETE FROM yield_ledger_position_daily WHERE account_key IN (SELECT s.account_key FROM accounts s JOIN accounts b ON b.user_id = s.user_id AND b.chain_id = 8453 AND lower(b.address) = lower(s.address) WHERE s.chain_id <> 8453 AND s.remote_json IS NULL);
DELETE FROM yield_ledger_position_collected WHERE account_key IN (SELECT s.account_key FROM accounts s JOIN accounts b ON b.user_id = s.user_id AND b.chain_id = 8453 AND lower(b.address) = lower(s.address) WHERE s.chain_id <> 8453 AND s.remote_json IS NULL);
DELETE FROM yield_ledger_account_receipts WHERE account_key IN (SELECT s.account_key FROM accounts s JOIN accounts b ON b.user_id = s.user_id AND b.chain_id = 8453 AND lower(b.address) = lower(s.address) WHERE s.chain_id <> 8453 AND s.remote_json IS NULL);
DELETE FROM account_cap_overrides WHERE account_key IN (SELECT s.account_key FROM accounts s JOIN accounts b ON b.user_id = s.user_id AND b.chain_id = 8453 AND lower(b.address) = lower(s.address) WHERE s.chain_id <> 8453 AND s.remote_json IS NULL);
DELETE FROM accounts WHERE account_key IN (SELECT s.account_key FROM accounts s JOIN accounts b ON b.user_id = s.user_id AND b.chain_id = 8453 AND lower(b.address) = lower(s.address) WHERE s.chain_id <> 8453 AND s.remote_json IS NULL);
