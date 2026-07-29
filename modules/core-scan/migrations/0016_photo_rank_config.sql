-- Always-on AI catalog-photo ranking: a per-workspace config (singleton).
--
-- The ✨ Pick best (AI) button is per-press and costs nothing until tapped. This
-- row is the OPT-IN for doing it automatically on every enriched scan: a wire
-- fires on core-scan.scan.enriched and the handler no-ops unless `enabled` is
-- true here. `enabled` DEFAULTS FALSE and the row is not seeded, so a workspace
-- that never opts in has no row and spends nothing (absence == off) — the same
-- shape digifab_failure_config uses for its opt-in AI watcher. That is also why
-- no boot reconcile is needed for existing workspaces: there is nothing to heal.
--
-- manual recovery if this fails partway:
--   DROP TABLE IF EXISTS core_scan_photo_rank_config;
--   DELETE FROM _prisma_migrations WHERE migration_name = '0016_photo_rank_config';

CREATE TABLE IF NOT EXISTS core_scan_photo_rank_config (
  id boolean PRIMARY KEY DEFAULT true,
  enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT core_scan_photo_rank_config_singleton CHECK (id)
);
