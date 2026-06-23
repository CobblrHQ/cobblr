-- First-import gate for sync.
--
-- An entity-type sync stays in PREVIEW until its first import is approved:
-- the user pulls a dry-run plan, eyeballs it, and approves. Only then does
-- live sync (poll + webhook) start writing.
--
--   import_approved_at IS NULL  → not yet imported. Live poll + webhook are
--                                 withheld; only preview + import are allowed.
--   import_approved_at IS SET   → the one-time import ran; live sync is active.
--
-- Existing rows (pre-gate, already syncing live) are backfilled to now() so we
-- don't strand a live connection in preview after deploy.

alter table core_integrations_sync_state
  add column import_approved_at timestamptz;

update core_integrations_sync_state
  set import_approved_at = now()
  where enabled = true;

-- manual recovery if this fails partway:
--   ALTER TABLE core_integrations_sync_state DROP COLUMN import_approved_at;
--   DELETE FROM _prisma_migrations WHERE migration_name = '0003_import_gate';
