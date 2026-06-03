-- Installed third-party preview renderers (per workspace — this table
-- lives in the tenant DB). The renderer_js bundle runs only in the client
-- sandbox; signed_by records the ed25519 key it was signed with (if any).
--
-- manual recovery if this fails partway:
--   DROP TABLE IF EXISTS core_file_preview_renderers;
--   DELETE FROM _prisma_migrations WHERE migration_name = '0001_init';
CREATE TABLE core_file_preview_renderers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  version text,
  exts text[] NOT NULL,
  renderer_js text NOT NULL,
  signed_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
