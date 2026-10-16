-- Environment and test flag on accounts (otto/mamoru#130). Additive only. Numbered by the coordinator at merge.
--
-- app.mamoru.lol (prod) and beta.mamoru.lol (beta) share this D1 and this chain_id: nothing stored today says
-- which Worker created a given account, so `env` cannot be derived retroactively from the existing columns.
-- The DEFAULT below is the backfill: the beta canary did not exist before 2026-10-01 (commit 995711a, "add beta
-- canary environment and BETA badge"), so every account created before that date is certainly prod, and the
-- default alone classifies them correctly. No UPDATE is needed for that range.
--
-- Accounts created on or after 2026-10-01 are NOT reliably classified by this default: same table, same
-- chain_id, no recorded host. Before applying this migration, the coordinator must cross-reference Cloudflare
-- Workers Logs for mamoru-app-beta (POST /api/onboarding/owner 201s, which carry account_key) against the rows
-- the SELECT below lists, and extend the UPDATE block with the beta account_keys it finds. Going forward this
-- is moot: the Worker now writes env explicitly at onboarding (apps/mamoru-app/src/api/onboarding/routes.ts).
--
-- `is_test`: Ot's own test account plus any coordinator smoke-test account made by hand during QA (none of
-- these are written by the onboarding flow itself, which always writes is_test = 0 for a real signup).

ALTER TABLE accounts ADD COLUMN env TEXT NOT NULL DEFAULT 'prod' CHECK (env IN ('prod', 'beta'));
ALTER TABLE accounts ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1));

-- Ot's test account (research 2026-10-15, otto/mamoru#130): account_key is a UUID, matched by its first group.
UPDATE accounts SET is_test = 1 WHERE account_key LIKE '00a7a1df-%';

-- Coordinator: add any other known smoke-test account_keys here before applying, e.g.:
-- UPDATE accounts SET is_test = 1 WHERE account_key IN ('...');

-- Coordinator: rows left at the 'prod' default that need beta/prod triage against Workers Logs before this
-- migration is applied (empty on a dev/test database; real only against the live D1):
-- SELECT account_key, address, created_at FROM accounts WHERE created_at >= '2026-10-01' AND env = 'prod';
