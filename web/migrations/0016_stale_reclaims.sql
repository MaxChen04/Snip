-- How many times a capture was taken back from an agent that stopped responding. After three it
-- fails instead of being handed out again; a Recapture starts the count over.
ALTER TABLE refs ADD COLUMN stale_reclaims INTEGER NOT NULL DEFAULT 0;
