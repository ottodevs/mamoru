-- otto/mamoru#26 (UI: otto/mamoru-astro#25): a cap per account, over the environment's cap (spec 006 engine
-- settings), so a named account can run more (or less) than the public cap. Written by /ops, read by the app Worker
-- for the operator (`accountCaps` of the signed engine-settings payload). Append-only, like engine_settings_versions:
-- no code path updates or deletes a row. The newest row of an account wins; cap_usdc NULL removes the override (the
-- account is back on its environment's cap). Whole USDC, bounds 1..1,000,000 (validateAccountCapOverride in
-- packages/policy). A cap above the default still needs depth sizing and a target-weights policy at the operator.
-- Additive: a Worker without this table serves an empty map. Apply by hand after 0015:
-- bunx wrangler d1 execute mamoru --remote --file migrations/d1/NNNN_account_cap_overrides.sql

CREATE TABLE IF NOT EXISTS account_cap_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  env TEXT NOT NULL CHECK (env IN ('prod', 'beta')),
  account_key TEXT NOT NULL,
  cap_usdc INTEGER,
  author TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS account_cap_overrides_account ON account_cap_overrides (account_key, id);
