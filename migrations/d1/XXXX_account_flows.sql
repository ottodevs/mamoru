-- External USDC flows of an account, for net deposited (USDC the owner sent minus withdrawn): the baseline of the
-- Portfolio's "vs idle USDC" (otto/mamoru#380). Additive only; the coordinator numbers it and applies it (NOT applied
-- by the pull request that adds it), before the Worker that writes and reads it.
--
-- One row per flow, never per day. The operator serves the flows it holds on every snapshot (deposit rows and
-- confirmed owner transfers, apps/mamoru-operator/src/flows.ts, capped at 200 deposits and a one-day first backfill),
-- the Worker writes each id once (ON CONFLICT DO NOTHING) so D1 keeps what the operator later forgets. Moves between
-- the owner's own Safes (CCTP legs) and the yield fee a withdrawal pays are not flows.
-- usd is raw USDC (6 decimals), always positive; kind says the direction.
CREATE TABLE account_flows (
  chain_id INTEGER NOT NULL,
  account_key TEXT NOT NULL,
  flow_id TEXT NOT NULL,          -- 'in:<tx>:<logIndex>' or 'out:<tx>', as the operator names it
  kind TEXT NOT NULL CHECK (kind IN ('in', 'out')),
  t_s INTEGER NOT NULL,
  usd INTEGER NOT NULL CHECK (usd > 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (chain_id, account_key, flow_id)
) WITHOUT ROWID;
CREATE INDEX account_flows_t ON account_flows (chain_id, account_key, t_s);
