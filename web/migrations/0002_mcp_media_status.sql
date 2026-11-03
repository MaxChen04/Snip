-- Contact sheets, sampled frames and provenance for animations; capture worker presence.
ALTER TABLE animations ADD COLUMN sheet_key TEXT;
ALTER TABLE animations ADD COLUMN meta_json TEXT;

CREATE TABLE worker_presence (
  id TEXT PRIMARY KEY,
  last_seen_at TEXT NOT NULL,
  activity TEXT NOT NULL CHECK (activity IN ('idle', 'busy')),
  job_id TEXT
);
