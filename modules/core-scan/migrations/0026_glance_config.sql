-- The first-look question on the camera: a per-workspace opt-in (singleton).
--
-- With it on, a photo with no barcode gets a fast, cheap "first look" the moment
-- it lands - name, category, confidence - and the camera card asks "we think it's
-- X, is that right?" while the full read runs. That is an AI call on every photo,
-- so it is OFF unless a row says otherwise: no row means off, a workspace that
-- never opts in spends nothing, and existing workspaces need no reconcile
-- (absence already means the right thing). Same shape as photo_rank_config.
--
-- manual recovery if this fails partway:
--   DROP TABLE IF EXISTS core_scan_glance_config;
--   DELETE FROM _prisma_migrations WHERE migration_name = '0026_glance_config';

CREATE TABLE IF NOT EXISTS core_scan_glance_config (
  id boolean PRIMARY KEY DEFAULT true,
  enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT core_scan_glance_config_singleton CHECK (id)
);
