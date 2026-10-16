-- Spec 006 (otto/mamoru#147): engine settings as versioned templates, written by /ops (mamoru-astro), read by the
-- app Worker for the operator. Append-only: no code path updates or deletes a version; a rollback is a new row
-- that copies an older one (rollback_of names it), so the version number only goes up.
-- Apply by hand after 0010: bunx wrangler d1 execute mamoru --remote --file migrations/d1/0011_engine_settings.sql

CREATE TABLE IF NOT EXISTS engine_settings_templates (
  name TEXT PRIMARY KEY,
  settings_json TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('seed', 'lab', 'ops')),
  note TEXT,
  author TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS engine_settings_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  env TEXT NOT NULL CHECK (env IN ('prod', 'beta')),
  -- NULL: every account of the environment. A JSON array of account keys: a canary, only those accounts.
  account_keys_json TEXT,
  template TEXT NOT NULL,
  settings_json TEXT NOT NULL,
  settings_hash TEXT NOT NULL,
  author TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  rollback_of INTEGER REFERENCES engine_settings_versions(id)
);

CREATE INDEX IF NOT EXISTS engine_settings_versions_env ON engine_settings_versions (env, id);

-- Seeds: the same three templates as ENGINE_SETTINGS_TEMPLATES in packages/policy/src/engine-settings.ts.
INSERT OR IGNORE INTO engine_settings_templates (name, settings_json, source, note, author, created_at) VALUES
  ('conservador-live-v2 (today)', '{"capUsdc":null,"depth":null,"guard":{"btc":{"fallBps":700,"volBps":8000},"enabled":false,"eth":{"fallBps":900,"volBps":10000}}}', 'seed', 'What ran before settings existed.', 'migration', '2026-10-16T00:00:00Z'),
  ('conservador + depth 30/500/5, cap 1000', '{"capUsdc":1000,"depth":{"impactBps":30,"shareBps":500,"stablesImpactBps":5},"guard":{"btc":{"fallBps":700,"volBps":8000},"enabled":false,"eth":{"fallBps":900,"volBps":10000}}}', 'seed', 'Spec 005 phase 1 thresholds; first cap step.', 'migration', '2026-10-16T00:00:00Z'),
  ('lab guards (fall freeze 7%/9%)', '{"capUsdc":null,"depth":null,"guard":{"btc":{"fallBps":700,"volBps":8000},"enabled":true,"eth":{"fallBps":900,"volBps":10000}}}', 'seed', 'Spec 004 freeze-only guard, passed the Lab gate 16 Oct.', 'migration', '2026-10-16T00:00:00Z');
