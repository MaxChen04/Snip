-- What the capture agent noticed about a page when it captured it: a JSON list of "blank" or "truncated".
-- Null for pages captured without it.
ALTER TABLE pages ADD COLUMN warnings_json TEXT;
