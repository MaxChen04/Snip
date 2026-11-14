-- Who holds a capturing reference right now: a random token the server issues on every claim,
-- including a stale reclaim and a resume, and clears when the capture leaves capturing. Every agent
-- call for the capture must present it, so an agent that was replaced can no longer write.
-- capture_attempt stays the file namespace and page numbering of the capture. A capture already
-- running when this applies has no lease, so nobody can write to it; it is reclaimed once stale.
ALTER TABLE refs ADD COLUMN capture_lease TEXT;
