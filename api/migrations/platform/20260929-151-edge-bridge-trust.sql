-- What a bridge reports it will reach (its own BRIDGE_ALLOW list; null when it
-- reaches whatever it is sent), and the API token it last registered with, so
-- a workspace can cut a bridge off by revoking exactly that key.
ALTER TABLE edge_bridges ADD COLUMN IF NOT EXISTS allowlist jsonb;
ALTER TABLE edge_bridges ADD COLUMN IF NOT EXISTS token_id uuid;
