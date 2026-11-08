-- Passkeys are an owner-only convenience; GitHub stays the path for a second person.
-- public_key is the raw COSE credential public key returned by registration.
CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners (id) ON DELETE CASCADE,
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  device_label TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX passkeys_owner ON passkeys (owner_id);
