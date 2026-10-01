-- Append-only history of every registry pool at the safe block, one row per sync (Lab backtesting dataset). Additive only.
-- Integers wider than 53 bits are decimal strings. A second sync on the same safe block is a no-op.

CREATE TABLE pool_snapshots (
  chain_id INTEGER NOT NULL,
  pool_address TEXT NOT NULL,
  block INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  block_time INTEGER NOT NULL,          -- unix seconds
  sqrt_price_x96 TEXT NOT NULL,
  tick INTEGER NOT NULL,
  liquidity TEXT NOT NULL,
  fee_growth_global0_x128 TEXT NOT NULL,
  fee_growth_global1_x128 TEXT NOT NULL,
  tick_cumulative TEXT,                 -- observe([0]); null when the oracle cannot answer
  fee_protocol INTEGER NOT NULL,        -- slot0.feeProtocol: low 4 bits token0, high 4 bits token1
  base_fee_wei TEXT,                    -- base fee of the block; null when the node omits it
  PRIMARY KEY (chain_id, pool_address, block)
) WITHOUT ROWID;
