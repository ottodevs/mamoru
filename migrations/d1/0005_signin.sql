-- Returning-user sign-in with the owner passkey (otto/mamoru#6). Additive only.

-- Sign-in challenges are stateless (HMAC, 5 min); a row here marks one as spent, so an assertion cannot be replayed.
CREATE TABLE auth_challenge_used (
  challenge TEXT PRIMARY KEY,   -- base64url of the 32 random bytes
  expires_at INTEGER NOT NULL   -- unix seconds; rows past it are deleted on the next sign-in
);
CREATE INDEX auth_challenge_used_expiry ON auth_challenge_used(expires_at);

-- Fixed-window counters. key is 'ip:<bucket 0..4095>' (sign-in attempts), 'onb:<bucket>' (onboarding attempts) or 'cred:<sha256>' (failures, only for credential ids
-- that belong to an account): no raw IP or credential id is stored, and the table cannot outgrow buckets + accounts per window.
CREATE TABLE auth_rate (
  key TEXT NOT NULL,
  window INTEGER NOT NULL,      -- unix seconds of the window start
  count INTEGER NOT NULL,
  PRIMARY KEY (key, window)
);
CREATE INDEX auth_rate_window ON auth_rate(window);

-- Last signature counter seen at sign-in. 0 for synced passkeys, which never count; a counter that stops increasing is a cloned authenticator.
ALTER TABLE accounts ADD COLUMN passkey_sign_count INTEGER NOT NULL DEFAULT 0;

-- A credential id owns at most one account per chain: sign-in finds exactly one row, and nobody can pile rows onto
-- someone else's credential id. Production had 40 accounts and no duplicate when this was written (2026-10-02).
CREATE UNIQUE INDEX accounts_chain_credential ON accounts(chain_id, passkey_credential_id);
