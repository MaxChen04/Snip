-- Images the owner uploads as moodboard material. The browser makes the thumbnail and palette
-- (palette_json: up to 6 "#rrggbb" strings); files live under uploads/<id>/.
CREATE TABLE images (
  id TEXT PRIMARY KEY,
  title TEXT,
  file_key TEXT NOT NULL,
  thumb_key TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  mime TEXT NOT NULL,
  palette_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX images_created ON images (created_at DESC, id DESC);

-- Images on boards (collections), like reference_collections.
CREATE TABLE image_collections (
  collection_id TEXT NOT NULL REFERENCES collections (id) ON DELETE CASCADE,
  image_id TEXT NOT NULL REFERENCES images (id) ON DELETE CASCADE,
  added_at TEXT NOT NULL,
  PRIMARY KEY (collection_id, image_id)
);
CREATE INDEX ic_image ON image_collections (image_id);

-- Titled frames on a board's canvas. Deleting one leaves its items in place, ungrouped.
CREATE TABLE board_groups (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES collections (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  x REAL NOT NULL,
  y REAL NOT NULL,
  w REAL NOT NULL,
  h REAL NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX board_groups_collection ON board_groups (collection_id);

-- Where each board member sits on the board's canvas, plus the board's sticky notes (which exist
-- only here, so text is set exactly for notes). A member without a row has not been placed yet.
-- Pages are keyed like page_collections, by (reference id as item_id, page_path), so their
-- positions survive a re-capture; every other kind has page_path ''. item_id points at different
-- tables per kind, so removing a member deletes its row in code rather than by cascade.
CREATE TABLE board_items (
  collection_id TEXT NOT NULL REFERENCES collections (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('reference', 'page', 'image', 'note')),
  item_id TEXT NOT NULL,
  page_path TEXT NOT NULL DEFAULT '',
  x REAL NOT NULL,
  y REAL NOT NULL,
  w REAL,
  group_id TEXT REFERENCES board_groups (id) ON DELETE SET NULL,
  text TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (collection_id, kind, item_id, page_path),
  CHECK ((kind = 'note') = (text IS NOT NULL))
);
CREATE INDEX board_items_item ON board_items (item_id, kind);
CREATE INDEX board_items_group ON board_items (group_id);
