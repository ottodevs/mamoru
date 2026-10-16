-- Environment and test flag on accounts (otto/mamoru#130). Additive only. Numbered by the coordinator at
-- merge, after this file but before 0008_metrics_daily_v2.sql (that table's writer reads accounts.env).
--
-- app.mamoru.lol (prod) and beta.mamoru.lol (beta) share this D1 and this chain_id: nothing stored today says
-- which Worker created a given account, so `env` cannot be derived retroactively from the existing columns.
-- The DEFAULT below is the backfill: the beta canary did not exist before 2026-10-01 (commit 995711a, "add beta
-- canary environment and BETA badge"), so every account created before that date is certainly prod, and the
-- default alone classifies them correctly. No UPDATE is needed for that range.
--
-- `env` records only WHERE an account was created (the onboarding host), not where it is used afterward.
-- app.mamoru.lol and beta.mamoru.lol share this D1, so an account created on one host that later signs in
-- from the other keeps its original env forever; attributing per-session *activity* to the host it happened
-- on is a different, out-of-scope question that this column does not answer (see env-of-host.ts).
--
-- Accounts created on or after 2026-10-01 are NOT reliably classified by this default: same table, same
-- chain_id, no recorded host. After applying the ALTER below (so the env column exists to query), the
-- coordinator must run the SELECT at the bottom of this file, cross-reference its rows against Cloudflare
-- Workers Logs for mamoru-app-beta (POST /api/onboarding/owner 201s, which carry account_key), and run an
-- UPDATE ... SET env = 'beta' WHERE account_key IN (...) for whatever it finds before trusting any report
-- that groups by env. Going forward this is moot: the Worker now writes env explicitly at onboarding
-- (apps/mamoru-app/src/api/onboarding/routes.ts), fail-closed — a host that is neither of the two is refused,
-- never defaulted to prod.
--
-- `is_test`: Ot's own test account plus any coordinator smoke-test account made by hand during QA (none of
-- these are written by the onboarding flow itself, which always writes is_test = 0 for a real signup).

ALTER TABLE accounts ADD COLUMN env TEXT NOT NULL DEFAULT 'prod' CHECK (env IN ('prod', 'beta'));
ALTER TABLE accounts ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1));

-- Ot's test account (research 2026-10-15, otto/mamoru#130): account_key is a UUID, matched by its first
-- group. The length guard is defense in depth against the prefix ever matching something that is not the
-- full 36-character UUID this account_key actually is; the coordinator should still confirm the exact
-- account_key against logs before applying, and change this to an exact `=` match if there is any doubt.
UPDATE accounts SET is_test = 1 WHERE account_key LIKE '00a7a1df-%' AND length(account_key) = 36;

-- Coordinator: add any other known smoke-test account_keys here before applying, e.g.:
-- UPDATE accounts SET is_test = 1 WHERE account_key IN ('...');

-- Coordinator: run this AFTER the ALTER above (it needs the env column to exist), BEFORE trusting any
-- report that groups by env. Lists rows left at the 'prod' default that need beta/prod triage against
-- Workers Logs (empty on a dev/test database; real only against the live D1):
-- SELECT account_key, address, created_at FROM accounts WHERE created_at >= '2026-10-01' AND env = 'prod';
