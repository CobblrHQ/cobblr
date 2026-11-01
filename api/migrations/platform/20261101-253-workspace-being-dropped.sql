-- A workspace whose delete has begun: stamped and committed before its files
-- are erased or its database is dropped, cleared only by the row's own
-- removal. A delete that died between the drop and the row's removal used to
-- leave a workspace with no database, still in every member's switcher, that
-- the deletion reaper could never finish (its final backup read the dropped
-- database). The stamp is the intent: the tenant door answers "being
-- deleted", the switcher leaves it out, and the reaper finishes it (#9071).
-- Additive: a nullable column, read by nothing that predates it.
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS dropping_at timestamptz;
CREATE INDEX IF NOT EXISTS orgs_dropping_idx ON orgs (dropping_at) WHERE dropping_at IS NOT NULL;
