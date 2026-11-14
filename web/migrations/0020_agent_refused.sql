-- The capture protocol of the last agent the Worker turned away with 426 (see web/shared/capture-protocol.ts), so the banner can say
-- its version is wrong instead of calling it offline. It is kept on a second worker_presence row, id 'refused', whose last_seen_at is
-- when it was turned away: the agent's own row, id 'capture', stays the contact of an agent that was accepted. NULL on that row, and
-- on a refusal from an agent too old to send a protocol.
ALTER TABLE worker_presence ADD COLUMN protocol INTEGER;
