-- Per-account scope for an ops flag (otto/mamoru#217). Additive: a nullable column on the append-only ops_flag_changes
-- (0012). Today only `multichain_v6` honors it (Operator.v4Target); every other flag ignores the column.
--
-- accounts, read from the flag's rows in id order:
--   a list      comma-separated (or a JSON array of strings) of account keys and/or Safe addresses: only those accounts
--               are offered what the flag enables. Empty or unparseable = an empty list = nobody (fail closed).
--   '*'         explicit "everyone" (also what a flag with no scope row ever has).
--   NULL        "carry the previous scope": the newest non-NULL value for that flag applies. /ops flips write NULL, so a
--               pause/resume never widens a scoped flag. To widen, insert a row with '*'.
-- A scoped flag is served as flags.<name> = false plus scopedFlags.<name> = [list], so an operator that predates this
-- reads it as off. A new operator offers v6 only on an explicit scopedFlags entry (null = everyone, or a list); a Worker
-- that sends none offers nobody v6.
-- Deploy order: this migration, then the Worker, then the operator restart. Insert no scoped row before the new
-- operator is confirmed running.
-- Apply by hand once numbered: bunx wrangler d1 execute mamoru --remote --file migrations/d1/<NNNN>_ops_flag_accounts.sql

ALTER TABLE ops_flag_changes ADD COLUMN accounts TEXT;
