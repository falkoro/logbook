-- MCP OAuth for connectors that only take a URL (claude.ai, Cowork). A grant is one tokens row: the agent it
-- acts as, a short-lived access token (hash) and a rotating refresh token (refresh_hash). Revoking the row ends it.
CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL, -- JSON array, matched exactly
  created_at TEXT NOT NULL
);

-- One row per authorization: 'consent' while the owner looks at the approve page (hash = the form nonce), then
-- 'code' (hash = the code). claim marks a code as exchanged, so it works once.
CREATE TABLE oauth_codes (
  hash TEXT PRIMARY KEY,
  stage TEXT NOT NULL CHECK (stage IN ('consent', 'code')),
  client_id TEXT NOT NULL REFERENCES oauth_clients(id),
  human_id TEXT NOT NULL REFERENCES actors(id),
  agent_id TEXT REFERENCES actors(id),
  redirect_uri TEXT NOT NULL,
  challenge TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  claim TEXT
);

ALTER TABLE tokens ADD COLUMN expires_at TEXT;
ALTER TABLE tokens ADD COLUMN client_id TEXT REFERENCES oauth_clients(id);
ALTER TABLE tokens ADD COLUMN refresh_hash TEXT;
CREATE UNIQUE INDEX tokens_refresh_hash ON tokens(refresh_hash);
