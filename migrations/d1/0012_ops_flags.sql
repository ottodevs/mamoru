-- Ops runtime flags (otto/mamoru#129): the yield ledger's env-var gating (operator MAMORU_SNAPSHOT /
-- MAMORU_YIELD_LEDGER, app Worker YIELD_LEDGER) moves here so it is switchable from /ops (mamoru-astro) without
-- a redeploy or a restart. Append-only, like engine_settings_versions (0011): no code path updates or deletes a
-- row; flipping a flag is a new row, and its current value is the newest row for that name (no row = off).
-- Apply by hand after 0011: bunx wrangler d1 execute mamoru --remote --file migrations/d1/0012_ops_flags.sql

CREATE TABLE IF NOT EXISTS ops_flag_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  flag TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  author TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ops_flag_changes_flag ON ops_flag_changes (flag, id);
