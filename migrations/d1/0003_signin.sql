-- Returning-user sign-in with the owner passkey (otto/mamoru#6). Additive only.

-- Sign-in challenges are stateless (HMAC, 5 min); a row here marks one as spent, so an assertion cannot be replayed.
CREATE TABLE auth_challenge_used (
  challenge TEXT PRIMARY KEY,   -- base64url of the 32 random bytes
  expires_at INTEGER NOT NULL   -- unix seconds; rows past it are deleted on the next sign-in
);
CREATE INDEX auth_challenge_used_expiry ON auth_challenge_used(expires_at);

-- Fixed-window attempt counters. key is 'ip:<hmac>' or 'cred:<sha256>': no raw IP or credential id is stored.
CREATE TABLE auth_rate (
  key TEXT NOT NULL,
  window INTEGER NOT NULL,      -- unix seconds of the window start
  count INTEGER NOT NULL,
  PRIMARY KEY (key, window)
);
CREATE INDEX auth_rate_window ON auth_rate(window);

-- Sign-in finds the account by the credential id the authenticator returns.
CREATE INDEX accounts_passkey_credential ON accounts(passkey_credential_id);
