CREATE TABLE library_positions (
  kind TEXT NOT NULL CHECK (kind IN ('page', 'section', 'animation', 'image', 'website')),
  id TEXT NOT NULL,
  x REAL NOT NULL,
  y REAL NOT NULL,
  PRIMARY KEY (kind, id)
) WITHOUT ROWID;

CREATE TABLE library_position_version (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL CHECK (version > 0)
);
