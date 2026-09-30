-- Files through a bridge (the blob side-channel). One row per file in
-- transit: "down" is a file Cobblr sends to a service behind the bridge (the
-- path is the file Cobblr already holds; nothing is copied), "up" is a file
-- a service answers with, written to Cobblr's spool as the bridge delivers
-- it. Rows live minutes; expired ones are removed as new ones are made.
CREATE TABLE IF NOT EXISTS edge_blobs (
  id uuid PRIMARY KEY,
  channel_key text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('down', 'up')),
  path text NOT NULL,
  sha256 text,
  size bigint,
  received bigint NOT NULL DEFAULT 0,
  complete boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS edge_blobs_expires_idx ON edge_blobs (expires_at);
