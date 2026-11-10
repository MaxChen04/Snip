-- The page's computed-styles summary (StylesSummary as JSON, shared/style-parts.ts): counts, keyframe names and the
-- byte ranges of the split styles file. Null for pages captured before it, which fall back to reading styles.json.
ALTER TABLE pages ADD COLUMN styles_summary_json TEXT;
-- Ordered per-reference reads (get_reference parts "pages", "animations", "overview") page with a key instead of
-- reading every row: these indexes match their ORDER BY, so a page of 25 reads about 25 rows.
CREATE INDEX pages_ref_order ON pages (reference_id, ord, created_at, id);
CREATE INDEX animations_ref_order ON animations (reference_id, created_at, id);
DROP INDEX pages_ref;
DROP INDEX animations_ref;
