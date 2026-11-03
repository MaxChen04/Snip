ALTER TABLE refs ADD COLUMN capture_attempt TEXT;

CREATE TABLE capture_cleanup (
  prefix TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt TEXT
);

-- Records accepted writes until their post-write checks and cleanup have finished.
CREATE TABLE capture_uploads (
  id TEXT PRIMARY KEY,
  object_key TEXT NOT NULL
);
