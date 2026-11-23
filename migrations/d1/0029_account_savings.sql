-- otto/mamoru#413 (spec 012 savings-layer.md): an account's savings layer per UTC day, as the operator's books served it
-- on the Base snapshot (SafeSnapshot.savings, AccountSavings in @mamoru/domain). One row per account, chain and day, the
-- day's last read wins. Raw USDC amounts. Read by the Portfolio (savings shown beside earned) and nothing else: savings
-- are already in the account's idle and vault values, never added to them. Additive only.
CREATE TABLE account_savings_daily (
  day TEXT NOT NULL,               -- UTC YYYY-MM-DD of the read
  chain_id INTEGER NOT NULL,
  account_key TEXT NOT NULL,
  env TEXT NOT NULL DEFAULT 'unknown',
  usdc INTEGER NOT NULL,           -- pending + savings shares at the vault rate of the read
  basis_usdc INTEGER NOT NULL,     -- what entered savings, less the basis of what left
  pending_usdc INTEGER NOT NULL,   -- harvested USDC waiting in the Safe for the next savings deposit
  status TEXT NOT NULL,            -- 'counted' | 'partial' (a receipt not read yet)
  vaults_json TEXT NOT NULL,       -- [{ vault, shares, usdc, basisUsdc }], shares as decimal strings
  block INTEGER NOT NULL,
  read_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_key, chain_id, day)
) WITHOUT ROWID;
