-- Spec 013: the public Stats view, already through the k >= 3 guard, built by the cron after each yield-ledger pull
-- (apps/mamoru-app/src/worker.ts `scheduled`). GET /api/stats reads this one row instead of building the view from
-- every table on a cold edge cache. One row; additive only.
CREATE TABLE stats_view (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  view_json TEXT NOT NULL,
  built_ms INTEGER NOT NULL   -- when the view was built (ms since epoch)
);
