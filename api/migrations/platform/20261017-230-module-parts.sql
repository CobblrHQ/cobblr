-- Module parts: a workspace's own on or off for one part of a module.
--
-- Additive (lint:migration-additive): one new table. A part with no row here
-- follows its declared default, so existing workspaces change nothing.
--
-- manual recovery if this fails partway:
--   drop table if exists org_module_parts;

CREATE TABLE IF NOT EXISTS org_module_parts (
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  module_name text NOT NULL,
  part text NOT NULL,
  enabled boolean NOT NULL,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, module_name, part)
);
