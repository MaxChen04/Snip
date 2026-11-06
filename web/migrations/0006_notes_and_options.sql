-- A short note per website ("why I saved this"), searchable and returned over MCP.
ALTER TABLE refs ADD COLUMN notes TEXT;
-- Per-capture options (CaptureOptions JSON): color scheme, desktop width, saved sign-in.
ALTER TABLE refs ADD COLUMN capture_options TEXT;
