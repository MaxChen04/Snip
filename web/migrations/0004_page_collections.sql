-- Individual pages saved to collections. A page stays in its website and can sit in any number of
-- collections; membership points at the page's existing files, nothing is copied.
-- Keyed by (reference, path) rather than page id so membership survives a re-capture,
-- which replaces page rows.
CREATE TABLE page_collections (
  collection_id TEXT NOT NULL REFERENCES collections (id) ON DELETE CASCADE,
  reference_id TEXT NOT NULL REFERENCES refs (id) ON DELETE CASCADE,
  page_path TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (collection_id, reference_id, page_path)
);
CREATE INDEX pc_page ON page_collections (reference_id, page_path);
CREATE INDEX pages_path ON pages (reference_id, path);
