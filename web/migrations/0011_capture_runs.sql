-- Each Recapture starts a new run of the same reference. An MCP task names the run it
-- was created for, so a recapture ends the old task instead of silently following the new run.
ALTER TABLE refs ADD COLUMN capture_run INTEGER NOT NULL DEFAULT 1;
