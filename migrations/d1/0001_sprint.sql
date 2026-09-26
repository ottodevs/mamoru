-- Sprint schema shared by mamoru-app (L3) and mamoru-engine (L4). Owned by L0.
-- The app writes identity and accounts. The engine writes proj_* and source state.

CREATE TABLE users (
  user_id TEXT PRIMARY KEY,
  email TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE accounts (
  account_key TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id),
  chain_id INTEGER NOT NULL,
  address TEXT NOT NULL,
  owners_json TEXT NOT NULL,
  passkey_credential_id TEXT NOT NULL,
  passkey_x TEXT NOT NULL,
  passkey_y TEXT NOT NULL,
  salt_nonce TEXT NOT NULL,
  preset TEXT NOT NULL DEFAULT 'conservador',
  policy_version TEXT NOT NULL,
  recovery_ack_at TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX accounts_chain_address ON accounts(chain_id, address);
CREATE INDEX accounts_user ON accounts(user_id);

-- One row per pool of the plan. payload_json is a PoolView (packages/domain).
CREATE TABLE proj_pool_state (
  chain_id INTEGER NOT NULL,
  pool_address TEXT NOT NULL,
  block INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  source TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (chain_id, pool_address)
);

-- Chain view of each account. tokens_json is TokenHolding[] (packages/domain).
CREATE TABLE proj_account_state (
  account_key TEXT PRIMARY KEY REFERENCES accounts(account_key),
  chain_id INTEGER NOT NULL,
  block INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  deployed INTEGER NOT NULL,
  tokens_json TEXT NOT NULL,
  total_value TEXT
);

-- Health of the chain reader and of the index, one row per chain.
CREATE TABLE source_state (
  chain_id INTEGER PRIMARY KEY,
  rpc_status TEXT NOT NULL,
  block INTEGER,
  safe_block INTEGER,
  observed_at TEXT NOT NULL,
  index_provider TEXT NOT NULL,
  index_status TEXT NOT NULL,
  index_block INTEGER,
  index_code TEXT,
  index_checked_at TEXT NOT NULL
);
