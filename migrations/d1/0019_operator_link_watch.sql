-- Worker -> operator link watch, otto/mamoru#207 (incident otto/mamoru#205: the Worker lost the operator for
-- ~55 h and nothing said so). apps/mamoru-app/src/api/operator-link-watch.ts probes each configured operator's
-- /health every cron tick and keeps one row per chain here. Prod and beta share this D1 and both run the cron:
-- the conditional UPDATE ... RETURNING on these rows is what lets exactly one of them post each alert.
-- Additive. Apply before the Worker that reads it: bunx wrangler d1 execute mamoru --remote --file migrations/d1/0019_operator_link_watch.sql

CREATE TABLE IF NOT EXISTS operator_link_watch (
  chain_id INTEGER PRIMARY KEY,
  down_since TEXT,        -- ISO, Worker clock: first failed probe of the current outage; NULL while the link is up
  last_error TEXT,        -- short reason of the last failed probe (never a URL or a secret)
  last_alert_at TEXT,     -- ISO: last "down" alert claimed for this outage (put back when nothing delivered it)
  alerted INTEGER NOT NULL DEFAULT 0,  -- 1 once any "down" alert of this outage was delivered
  alert_inflight TEXT,    -- ISO claim of a "down" whose send has not returned yet; a "recovered" waits for it (60 s cap)
  recovery_pending TEXT,  -- ISO down_since of an outage that ended with alerted = 1 and whose "recovered" is not delivered yet
  checked_at TEXT NOT NULL
);
