-- Spec 013 amendment A1, task A1-D2. Additive only; the coordinator numbers and applies it before the Worker that writes it.
--
-- The latest snapshot keeps each Safe's idle balance split by token, in raw USDC at the read's prices (operator
-- `tokensUsdc`), so Stats' "By token" and "In stablecoins" are exact. JSON object {symbol: "raw USDC"}; NULL for rows
-- written by an operator older than the field (Stats then hides the figures that need it). Positions' legs
-- (`value0Usdc`/`value1Usdc` with `token0`/`token1` and `amount0`/`amount1`) go in the existing positions_json.
ALTER TABLE account_snapshot_latest ADD COLUMN tokens_json TEXT;
