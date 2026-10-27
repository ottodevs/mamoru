-- Worker -> operator link watch, otto/mamoru#207 (incident otto/mamoru#205: the Worker lost the operator for
-- ~55 h and nothing said so). apps/mamoru-app/src/api/operator-link-watch.ts probes each configured operator's
-- /health every cron tick and keeps one row per chain here. Prod and beta share this D1 and both run the cron:
-- the conditional UPDATE ... RETURNING on these rows is what lets exactly one of them post each alert.
-- Additive. Apply before the Worker that reads it: bunx wrangler d1 execute mamoru --remote --file migrations/d1/XXXX_operator_link_watch.sql

CREATE TABLE IF NOT EXISTS operator_link_watch (
  chain_id INTEGER PRIMARY KEY,
  down_since TEXT,        -- ISO, Worker clock: first failed probe of the current outage; NULL while the link is up
  last_error TEXT,        -- short reason of the last failed probe (never a URL or a secret)
  last_alert_at TEXT,     -- ISO: last "down" alert actually delivered for this outage; NULL when none was
  checked_at TEXT NOT NULL
);
