-- The desktop page cut into its visual sections (PageSection[] as JSON). Null for pages captured before sections.
ALTER TABLE pages ADD COLUMN sections_json TEXT;
