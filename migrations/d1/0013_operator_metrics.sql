-- Operator GET /metrics mirrored into D1 for the /ops console (separate repo) to read, otto/mamoru#129
-- follow-up. apps/mamoru-app/src/worker.ts `scheduled` pulls the operator's signed /metrics every cron tick
-- (apps/mamoru-app/src/api/operator-metrics.ts), not gated by the yield_ledger flag: it costs the operator
-- nothing beyond its own cached relayer balance. Single row, like account_snapshot_latest's shape but for the
-- whole operator rather than per account; payload_json is the trimmed shape operator-metrics.ts's
-- StoredOperatorMetrics documents (drops rpc.cumulative and rpc.logRanges, which the operator itself already
-- redacts of secrets but which this console does not need). A failed pull leaves the row as it was.
-- Apply by hand after 0012: bunx wrangler d1 execute mamoru --remote --file migrations/d1/0013_operator_metrics.sql

CREATE TABLE IF NOT EXISTS operator_metrics_latest (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  payload_json TEXT NOT NULL,     -- StoredOperatorMetrics, JSON (operator-metrics.ts)
  generated_at TEXT NOT NULL,     -- ISO, operator clock (the pulled payload's own generatedAt)
  fetched_at TEXT NOT NULL        -- ISO, Worker clock (when this row was written)
);
