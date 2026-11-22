-- External USDC flows of an account, for net deposited (USDC the owner sent minus withdrawn): the baseline of the
-- Portfolio's "vs idle USDC" (otto/mamoru#380). Additive only; the coordinator numbers it and applies it (NOT applied
-- by the pull request that adds it), before the Worker that writes and reads it.
--
-- One row per flow, never per day. The operator serves the flows it holds on every snapshot (deposit rows and
-- confirmed owner transfers, apps/mamoru-operator/src/flows.ts, capped at 200 deposits and a one-day first backfill),
-- the Worker writes each id once (ON CONFLICT DO NOTHING) so D1 keeps what the operator later forgets. Moves between
-- the owner's own Safes (CCTP legs) are not flows. A withdrawal's 'out' includes the yield fee it paid (it left the Safe);
-- the reader subtracts the whole fee owed from the net once.
-- usd is raw USDC (6 decimals), positive; kind says the direction. kind 'gap' (usd 0) is not money: the operator says it
-- cannot vouch for the flows (a deposit list at its cap, a withdrawal whose receipt was given up on), so the reader
-- marks the net deposited partial. kind 'cover' (usd 0) is the operator vouching that its flows are gap-free from t_s on:
-- without one the net deposited is never 'complete' (otto/mamoru#438: the operator side, not sent yet).
CREATE TABLE account_flows (
  chain_id INTEGER NOT NULL,
  account_key TEXT NOT NULL,
  flow_id TEXT NOT NULL,          -- 'in:<tx>:<logIndex>', 'out:<tx>' or 'gap:<why>'
  kind TEXT NOT NULL CHECK (kind IN ('in', 'out', 'gap', 'cover')),
  t_s INTEGER NOT NULL,
  usd INTEGER NOT NULL CHECK (usd > 0 OR (kind IN ('gap', 'cover') AND usd = 0)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (chain_id, account_key, flow_id)
) WITHOUT ROWID;
CREATE INDEX account_flows_t ON account_flows (chain_id, account_key, t_s);
