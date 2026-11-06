-- Spec 013 amendment A1: vault yield per account and UTC day before the income ledger existed, so Stats' APR and
-- earned-per-day series (T1, T2, S6) can start on the first day every chain is known. Written once by
-- apps/mamoru-operator/scripts/stats-backfill.ts (archive reads of share prices at each day's close: shares held at
-- close × the share-price change over the day), applied by the coordinator with INSERT OR IGNORE. Read only by the
-- Stats series; never by earned.ts, so Total earned (S5) is not counted twice. Additive only.
CREATE TABLE stats_vault_daily (
  day TEXT NOT NULL,          -- UTC YYYY-MM-DD
  chain_id INTEGER NOT NULL,
  account_key TEXT NOT NULL,
  usd INTEGER NOT NULL,       -- raw USDC
  PRIMARY KEY (day, chain_id, account_key)
) WITHOUT ROWID;
