-- What search reads for each page besides its own row: the section kinds and labels ("hero: Simple pricing"), the visible text the capture
-- read off the page, and each section's share of that text (a JSON array in section order).
-- A plain table rather than FTS5: `wrangler d1 export`, which moves and backs up a library, refuses
-- databases with virtual tables.
CREATE TABLE page_text (
  page_id TEXT PRIMARY KEY REFERENCES pages (id) ON DELETE CASCADE,
  reference_id TEXT NOT NULL REFERENCES refs (id) ON DELETE CASCADE,
  sections TEXT,
  body TEXT,
  section_text_json TEXT
);
CREATE INDEX page_text_ref ON page_text (reference_id);
-- Pages captured before this keep their section labels searchable; their text arrives with a recapture.
INSERT INTO page_text (page_id, reference_id, sections)
  SELECT p.id, p.reference_id, (SELECT group_concat(json_extract(s.value, '$.kind') || ': ' || json_extract(s.value, '$.label'), ' | ') FROM json_each(p.sections_json) s)
  FROM pages p WHERE p.sections_json IS NOT NULL AND json_valid(p.sections_json);
