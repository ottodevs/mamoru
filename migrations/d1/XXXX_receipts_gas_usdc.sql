-- The gas Mamoru paid per account and day, in raw USDC (otto/mamoru#380: the Portfolio's Costs row). Additive only; the
-- coordinator numbers it and applies it (NOT applied by the pull request that adds it), before the Worker that writes it.
-- The operator prices each op's gas at the first snapshot that can (gasUsdc on the op facts) and serves the day's sum
-- on its receipts; null = a day with an op not priced yet (counted as not measured, never as 0).
ALTER TABLE yield_ledger_account_receipts ADD COLUMN gas_paid_usdc INTEGER;
