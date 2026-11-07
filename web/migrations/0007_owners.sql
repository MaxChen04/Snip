-- The owner identity of this install, created by the owner link. sessions_epoch is the
-- "Sign out all devices" counter: a session carries the epoch it was minted at and stops
-- working as soon as the stored value is higher.
CREATE TABLE owners (
  id TEXT PRIMARY KEY,
  label TEXT,
  created_at TEXT NOT NULL,
  sessions_epoch INTEGER NOT NULL DEFAULT 0,
  owner_secret_hash TEXT
);
