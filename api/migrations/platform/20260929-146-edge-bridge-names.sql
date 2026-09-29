-- A bridge a person can recognise (#3904). Until now a bridge was only its
-- channel key and when it last polled, so every screen called it "Default
-- bridge" or "Your main bridge", and the name somebody typed while installing
-- it labelled the API token and was never seen again. Additive only: every
-- column is nullable or defaulted, so an api that predates this keeps
-- inserting (channel_key) rows untouched.

ALTER TABLE edge_bridges ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE edge_bridges ADD COLUMN IF NOT EXISTS first_seen timestamptz NOT NULL DEFAULT now();
-- What the bridge says about itself when it registers: its version and the
-- machine it runs on, so a person can tell two bridges apart.
ALTER TABLE edge_bridges ADD COLUMN IF NOT EXISTS version text;
ALTER TABLE edge_bridges ADD COLUMN IF NOT EXISTS hostname text;
