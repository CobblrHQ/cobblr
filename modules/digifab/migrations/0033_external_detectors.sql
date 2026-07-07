-- External print-failure detectors: a workspace can point the failure watch at a
-- self-hosted detection service (Obico ML API, PrintGuard, a generic LAN box)
-- instead of / alongside the built-in edge + llm backends. Each detector is a
-- stored connection (base URL + encrypted token + config); the failure config's
-- `backend='detector'` selects one via `detector_id`. Additive only — existing
-- configs (auto/edge/llm) are untouched.
--
-- manual recovery if this fails partway:
--   ALTER TABLE digifab_failure_config DROP COLUMN IF EXISTS detector_id;
--   DROP TABLE IF EXISTS digifab_detectors;
--   DELETE FROM _prisma_migrations WHERE migration_name = '0033_external_detectors';

CREATE TABLE IF NOT EXISTS digifab_detectors (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- the detector PACKAGE key (obico-ml | printguard | local-http | …).
  key             text NOT NULL,
  label           text NOT NULL,
  base_url        text NOT NULL,
  -- AES-GCM ciphertext of { apiKey }; null when the service needs no auth.
  credentials_enc text,
  -- per-detector config, e.g. camera-watcher device→camera map:
  --   { "camera_map": { "<connId>:<deviceId>": "<remote camera id>" } }
  config          jsonb NOT NULL DEFAULT '{}',
  enabled         boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Which detector the watch uses when backend='detector'. Null = none selected
-- (detection then produces no reading, exactly like edge-only with no model).
ALTER TABLE digifab_failure_config ADD COLUMN IF NOT EXISTS detector_id uuid;
