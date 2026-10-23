-- Agent Lab bench (spec 008 phase 1, otto/mamoru#199). Additive. XXXX left for the coordinator to number at merge.
CREATE TABLE IF NOT EXISTS lab_runs (result_hash TEXT PRIMARY KEY, spec_key TEXT NOT NULL, window_id TEXT NOT NULL, summary_json TEXT NOT NULL, run_json TEXT NOT NULL, sim_version TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS lab_runs_spec ON lab_runs(spec_key);
CREATE INDEX IF NOT EXISTS lab_runs_window ON lab_runs(window_id);
CREATE TABLE IF NOT EXISTS lab_jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, origin TEXT NOT NULL DEFAULT 'ops', requester TEXT NOT NULL, spec_json TEXT NOT NULL, spec_key TEXT NOT NULL, status TEXT NOT NULL, lease_id TEXT, lease_until INTEGER, attempts INTEGER NOT NULL DEFAULT 0, result_hash TEXT, error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS lab_jobs_status ON lab_jobs(status, created_at);
CREATE TABLE IF NOT EXISTS lab_nonces (nonce TEXT PRIMARY KEY, seen_at INTEGER NOT NULL);
