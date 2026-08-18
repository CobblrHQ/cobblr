-- Edge relay backplane: move bridge presence + request routing out of process
-- memory and into cobblr_meta, so ANY api process can serve ANY bridge.
--
-- The registry was `new Map()` in api/src/platform/edge.ts, which meant the
-- bridge could only be reached from the one process its long-poll happened to
-- land on. A replaced container started empty until the bridge re-polled, and
-- during a blue-green overlap both containers sat in the load balancer while
-- the bridge was registered on exactly one of them — so requests alternated
-- between working and "no edge device connected". It also capped the api at a
-- single replica, for reasons unrelated to deploys.
--
-- Keys are channel keys, not org ids: a PERSONAL AI connection is keyed by the
-- owner's user id across all their workspaces, a workspace bridge by
-- `<orgId>` or `<orgId>::<name>`. That is why this lives in cobblr_meta rather
-- than a tenant database — one row set spans both kinds.

-- Which channels have a bridge polling, and when it was last heard from.
CREATE TABLE IF NOT EXISTS edge_bridges (
  channel_key text PRIMARY KEY,
  last_seen   timestamptz NOT NULL DEFAULT now()
);

-- One row per relayed request; the response is written back in place.
CREATE TABLE IF NOT EXISTS edge_relay_jobs (
  id          uuid PRIMARY KEY,
  channel_key text NOT NULL,
  request     jsonb NOT NULL,
  -- queued → claimed (a bridge took it) → done (response written)
  status      text NOT NULL DEFAULT 'queued',
  response    jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  claimed_at  timestamptz,
  done_at     timestamptz,
  -- The waiting process gives up at this point; the sweeper removes the row.
  expires_at  timestamptz NOT NULL
);

-- The claim query: oldest queued job for one channel.
CREATE INDEX IF NOT EXISTS edge_relay_jobs_claim_idx
  ON edge_relay_jobs (channel_key, status, created_at);

-- The sweeper.
CREATE INDEX IF NOT EXISTS edge_relay_jobs_expiry_idx
  ON edge_relay_jobs (expires_at);
