-- Pause and stop for running captures, honoured by the capture agent between pages.
-- capture_control: 'pause' or 'stop' while capturing (a request the agent has not acted on yet),
-- or 'paused' on a queued reference the queue skips until it is resumed. refs.status keeps its
-- original CHECK because rebuilding refs would cascade-delete its pages, so the API reports a
-- paused reference as status "paused".
ALTER TABLE refs ADD COLUMN capture_control TEXT;
-- Where a paused crawl left off (CrawlState JSON), handed back to the agent when it resumes.
ALTER TABLE refs ADD COLUMN crawl_state TEXT;
