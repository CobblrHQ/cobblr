-- A counter of a workspace's SHAPE: which modules are on, which collections it
-- has, which bundles are installed. Bumped by every write that changes one of
-- those (api/src/platform/workspace-shape.ts) and served on every workspace
-- response, so an open app notices its menu and destinations moved and
-- refetches them, whichever door made the change and however deep it ran
-- (a filing that installs a bundle does it in a nested request).
--
-- Additive, with a default: an older api neither reads nor writes it.
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS shape_version integer NOT NULL DEFAULT 0;
