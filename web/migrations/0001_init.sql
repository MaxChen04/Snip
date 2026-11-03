CREATE TABLE refs (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  domain TEXT NOT NULL,
  title TEXT,
  description TEXT,
  favicon TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('single', 'crawl')),
  max_pages INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'capturing', 'ready', 'failed')),
  progress TEXT,
  error TEXT,
  cover_key TEXT,
  page_count INTEGER NOT NULL DEFAULT 0,
  animation_count INTEGER NOT NULL DEFAULT 0,
  tokens_json TEXT,
  claimed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX refs_created ON refs (created_at DESC, id DESC);
CREATE INDEX refs_status ON refs (status, created_at);

CREATE TABLE pages (
  id TEXT PRIMARY KEY,
  reference_id TEXT NOT NULL REFERENCES refs (id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  path TEXT NOT NULL,
  title TEXT,
  ord INTEGER NOT NULL DEFAULT 0,
  desktop_key TEXT,
  desktop_thumb_key TEXT,
  desktop_width INTEGER,
  desktop_height INTEGER,
  mobile_key TEXT,
  mobile_thumb_key TEXT,
  mobile_width INTEGER,
  mobile_height INTEGER,
  snapshot_key TEXT,
  styles_key TEXT,
  tokens_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX pages_ref ON pages (reference_id, ord);
CREATE INDEX pages_created ON pages (created_at DESC, id DESC);

CREATE TABLE animations (
  id TEXT PRIMARY KEY,
  reference_id TEXT NOT NULL REFERENCES refs (id) ON DELETE CASCADE,
  page_id TEXT REFERENCES pages (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('scroll', 'hover')),
  label TEXT,
  selector TEXT,
  viewport TEXT NOT NULL DEFAULT 'desktop',
  gif_key TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX animations_ref ON animations (reference_id);
CREATE INDEX animations_created ON animations (created_at DESC, id DESC);

CREATE TABLE collections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE reference_collections (
  reference_id TEXT NOT NULL REFERENCES refs (id) ON DELETE CASCADE,
  collection_id TEXT NOT NULL REFERENCES collections (id) ON DELETE CASCADE,
  added_at TEXT NOT NULL,
  PRIMARY KEY (reference_id, collection_id)
);
CREATE INDEX rc_collection ON reference_collections (collection_id);
