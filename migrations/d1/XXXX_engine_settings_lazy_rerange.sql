-- otto/mamoru#172: seed template for the lazy re-range engine setting (spec 006 knob `rerange`). Additive: one
-- template row, no schema change; nothing runs it until /ops writes a version (or a canary) from it.
-- Needs the app Worker and the operator that know `rerange` first: an older Worker drops a version with it (unknown
-- setting), an older operator refuses the whole pull.
-- Apply by hand after 0011: bunx wrangler d1 execute mamoru --remote --file migrations/d1/XXXX_engine_settings_lazy_rerange.sql
INSERT OR IGNORE INTO engine_settings_templates (name, settings_json, source, note, author, created_at) VALUES
  ('conservador-live-v2 + lazy-h24h-b100-d30', '{"capUsdc":null,"depth":null,"guard":{"btc":{"fallBps":700,"volBps":8000},"enabled":false,"eth":{"fallBps":900,"volBps":10000}},"rerange":{"edgeBufferTicks":100,"horizonSeconds":86400,"lvrWeightBps":10000,"minDwellSeconds":1800,"mode":"lazy"}}', 'seed', 'Lab candidate: spec 004 lazy-h24h-b100-d30 (results/rebalance-policy-2026-10-16.md): gas -55-65%, mean return within +0.05..+0.26 pp, worst max drawdown +0.39/+0.45 pp. #172.', 'migration', '2026-10-18T00:00:00Z');
