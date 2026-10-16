-- Yield ledger: daily accrued/collected fees, gas Mamoru paid, and a hold-value baseline, per position
-- (otto/mamoru#129). Additive only, numbered by the coordinator at merge, not applied in this PR.
--
-- Builds on migrations/d1/XXXX_account_snapshots.sql (#136): account_snapshot_latest and account_daily already
-- carry the account-level totals (idle, lp, fees, owed) and reserve `collected_usdc`/`gas_paid_wei` on
-- account_daily for this ticket. This file adds the per-position detail the account-level rows do not carry:
-- each position's own accrued fees, what it collected, and a baseline to compare its current value against
-- simply holding its entry amounts (no LP, no harvest) revalued at today's price.
--
-- Written by the same Worker cron that writes account_snapshot_latest/account_daily once phase 2 of #136 is
-- turned on (apps/mamoru-app's `scheduled`, behind MAMORU_YIELD_LEDGER): it pulls GET /snapshot from the
-- operator and upserts both this file's tables and the #136 tables in one call. See apps/mamoru-app/src/api/yield-ledger.ts.
--
-- Column names and types match #136 and #130: env TEXT ('prod'|'beta'|'test'|'unknown', no default — beta shares
-- this D1, so a default would mislabel beta rows; the writer writes 'unknown' until #130 gives accounts an
-- environment, same as account_snapshot_latest), chain_id INTEGER, USD amounts INTEGER raw USDC (6 decimals).
-- Raw token amounts (accrued0/1, collected0/1, entry amounts) are TEXT decimal strings: fee growth is a uint256
-- and liquidity a uint128 (packages/uniswap-v3/src/fees.ts), too large to trust as an INTEGER (SQLite's 53-bit
-- safe range) for every token this reads (WETH is 18 decimals).

-- Captured once per position, the first day the ledger observes it: its then-current principal amounts
-- (amountsForLiquidity at that read), the best baseline available without indexing historical mint events (not
-- built yet; specs/003-snapshot-loop/spec.md phases 3-4). A position already open when MAMORU_YIELD_LEDGER is
-- first turned on gets its baseline from that moment, not from when it was actually opened: "value vs hold"
-- compares since this baseline, never since the position's real entry. Never overwritten after insert.
CREATE TABLE yield_ledger_position_entry (
  chain_id INTEGER NOT NULL,
  token_id INTEGER NOT NULL,
  account_key TEXT NOT NULL,
  address TEXT NOT NULL,              -- the Safe, lowercase 0x
  env TEXT NOT NULL CHECK (env IN ('prod', 'beta', 'test', 'unknown')),
  pool TEXT NOT NULL,                 -- registry pool name, e.g. 'pool:USDC/cbBTC/500'
  entry_day TEXT NOT NULL,            -- UTC YYYY-MM-DD this baseline was captured
  entry_block INTEGER NOT NULL,
  entry_amount0 TEXT NOT NULL,        -- raw token0 units at capture, decimal string
  entry_amount1 TEXT NOT NULL,        -- raw token1 units at capture, decimal string
  captured_at TEXT NOT NULL,          -- ISO, Worker clock
  PRIMARY KEY (chain_id, token_id)
) WITHOUT ROWID;

-- One row per position, chain and UTC day: open and close accrued fees (yield only, same fee math as #136),
-- what it collected that day, the position's own current value, and the hold baseline revalued at the day's
-- close price. "Value vs hold" and "earned so far" are derived by a reader from these columns, not pre-baked,
-- the same way the rest of this app leaves a figure null rather than inventing a derived number it cannot back:
--   earned so far   = accrued_usd_close + lifetime SUM(collected_usd)                       (yield only, ever)
--   value vs hold   = value_usd + accrued_usd_close - hold_value_usd                         (this position, this day)
--
-- Idempotent: the writer's first call of a UTC day INSERTs with open = close; every later call that day UPDATEs
-- only the close columns (ON CONFLICT DO UPDATE, the open columns are absent from the SET clause, so they keep
-- whatever the first insert of the day wrote). Day boundaries are "first and last snapshot of the UTC day" as
-- read, not carried forward from the previous day's close, matching account_daily (#136) exactly.
--
-- collected_usd/collected0/collected1 and fee_accrued_usd are NULL until a harvest or close_position for this
-- token id is known. No on-chain harvest has fired yet (otto/mamoru#129 research, 15 Oct) and the operator does
-- not yet decode collected amounts from a receipt, so this stays null rather than a fabricated zero (same rule
-- as account_daily's collected_usdc/gas_paid_wei). fee_accrued_usd is readiness for #108: what a 10% fee on
-- collected_usd would be, stored so #108 can decide with real numbers; nothing reads this column as a charge.
CREATE TABLE yield_ledger_position_daily (
  day TEXT NOT NULL,                  -- UTC YYYY-MM-DD
  chain_id INTEGER NOT NULL,
  token_id INTEGER NOT NULL,
  account_key TEXT NOT NULL,
  address TEXT NOT NULL,
  env TEXT NOT NULL CHECK (env IN ('prod', 'beta', 'test', 'unknown')),
  pool TEXT NOT NULL,
  block_open INTEGER NOT NULL,
  block_close INTEGER NOT NULL,
  accrued0_open TEXT NOT NULL,
  accrued1_open TEXT NOT NULL,
  accrued_usd_open INTEGER NOT NULL,
  accrued0_close TEXT NOT NULL,
  accrued1_close TEXT NOT NULL,
  accrued_usd_close INTEGER NOT NULL,
  value_usd INTEGER NOT NULL,         -- the position's own principal value at close (fees.ts math, snapshot's valueUsdc)
  hold_value_usd INTEGER NOT NULL,    -- yield_ledger_position_entry's amounts revalued at the close price
  collected0 TEXT,
  collected1 TEXT,
  collected_usd INTEGER,
  fee_accrued_usd INTEGER,            -- #108 readiness only: 10% of collected_usd when known, else null
  updated_at TEXT NOT NULL,           -- ISO, Worker clock
  PRIMARY KEY (day, chain_id, token_id)
) WITHOUT ROWID;

CREATE INDEX yield_ledger_position_daily_env_chain ON yield_ledger_position_daily (env, chain_id, day);
CREATE INDEX yield_ledger_position_daily_account ON yield_ledger_position_daily (account_key, day);
