-- PG72 ID OIDC relying-party state. Additive only: never touches existing diary tables.
PRAGMA foreign_keys = ON;

CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  subject TEXT NOT NULL,
  central_sid TEXT,
  display_name TEXT,
  email TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX auth_sessions_expiry_idx ON auth_sessions (expires_at);
CREATE INDEX auth_sessions_central_sid_idx ON auth_sessions (central_sid);
CREATE INDEX auth_sessions_subject_idx ON auth_sessions (subject);

CREATE TABLE auth_login_transactions (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL UNIQUE,
  code_verifier TEXT NOT NULL,
  nonce TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX auth_login_transactions_expiry_idx
  ON auth_login_transactions (expires_at, consumed_at);

-- Back-channel logout replay protection (jti dedupe).
CREATE TABLE auth_logout_jti (
  jti TEXT PRIMARY KEY,
  seen_at TEXT NOT NULL
);

CREATE INDEX auth_logout_jti_seen_idx ON auth_logout_jti (seen_at);
