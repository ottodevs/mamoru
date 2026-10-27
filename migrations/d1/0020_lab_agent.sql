-- Agent Lab agent (spec 008 phase 2, otto/mamoru#204). Additive.
-- SQLite needs one ALTER TABLE per statement — no multi-column ADD COLUMN.
ALTER TABLE lab_jobs ADD COLUMN thread_id TEXT;
ALTER TABLE lab_jobs ADD COLUMN question TEXT;
ALTER TABLE lab_jobs ADD COLUMN answer_json TEXT;
ALTER TABLE lab_jobs ADD COLUMN verifier_json TEXT;
ALTER TABLE lab_jobs ADD COLUMN cost_json TEXT;
ALTER TABLE lab_jobs ADD COLUMN quote_json TEXT;
ALTER TABLE lab_jobs ADD COLUMN payer TEXT;
CREATE TABLE IF NOT EXISTS lab_threads (id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS lab_job_runs (job_id TEXT NOT NULL, result_hash TEXT NOT NULL, PRIMARY KEY (job_id, result_hash));
CREATE TABLE IF NOT EXISTS lab_prices (resource TEXT NOT NULL, unit TEXT NOT NULL, usd REAL NOT NULL, valid_from TEXT NOT NULL, PRIMARY KEY (resource, unit, valid_from));
CREATE INDEX IF NOT EXISTS lab_jobs_thread ON lab_jobs(thread_id, created_at);
CREATE INDEX IF NOT EXISTS lab_threads_owner_updated ON lab_threads(owner, updated_at);
CREATE INDEX IF NOT EXISTS lab_job_runs_result_hash ON lab_job_runs(result_hash);
