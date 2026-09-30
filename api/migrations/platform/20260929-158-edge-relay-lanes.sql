-- A bridge's lanes and what it can do.
-- edge_relay_jobs.lane: which lane a queued call runs in on the bridge
-- (device, control, service, ai, sync), so a poll that names the lanes with
-- a free slot is handed only work the bridge can start now. Null (a call
-- queued before this) matches any poll.
-- edge_bridges.features: what the bridge reported it can do at register
-- (abort, headers, lanes, scope, ...). Null for a bridge that said nothing.
ALTER TABLE edge_relay_jobs ADD COLUMN IF NOT EXISTS lane text;
ALTER TABLE edge_bridges ADD COLUMN IF NOT EXISTS features jsonb;
