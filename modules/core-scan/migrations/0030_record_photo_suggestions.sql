-- A picture suggested for a record made without one (#3818).
--
-- One row per record the workspace made or renamed with no picture, whatever
-- door it came through (the kernel's platform.entity.saved signal). The row is
-- the queue AND the memory: `queued` until the picture search has run,
-- `suggested` with the picture it found, `none` when it found nothing,
-- `applied` once the picture is on the record, `declined` when the person
-- said No thanks. A declined record is not searched again unless its name
-- changes (`name` holds the name it was declined under).
--
-- The picture itself lives in the workspace's file store (`file_id`); the
-- record is never touched until someone says Use it, or the workspace asked
-- for suggestions to be applied (core_scan_photo_suggest_config).
--
-- Additive: two new tables, nothing existing changes. Absence of a config row
-- means suggest, never apply, so no workspace needs healing.
--
-- manual recovery if this fails partway:
--   DROP TABLE IF EXISTS core_scan_record_photo_suggestions;
--   DROP TABLE IF EXISTS core_scan_photo_suggest_config;

CREATE TABLE IF NOT EXISTS core_scan_record_photo_suggestions (
  entity_kind text NOT NULL,
  entity_id text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'suggested', 'none', 'applied', 'declined')),
  file_id uuid,
  source_url text,
  query text,
  attempts integer NOT NULL DEFAULT 0,
  user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_kind, entity_id)
);

CREATE INDEX IF NOT EXISTS core_scan_record_photo_suggestions_queued
  ON core_scan_record_photo_suggestions (created_at)
  WHERE status = 'queued';

CREATE TABLE IF NOT EXISTS core_scan_photo_suggest_config (
  id boolean PRIMARY KEY DEFAULT true,
  auto_apply boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT core_scan_photo_suggest_config_singleton CHECK (id)
);
