-- Toggle-able bundle features (Phase 2): remember which optional features a
-- bundle was installed with, so they can be changed later without losing the
-- choice. The feature DEFINITIONS live in the stored manifest jsonb
-- (bundles.manifest.features); this column records which keys are ON.
--
-- Additive + defaulted, so it applies cleanly to existing rows ('{}' = a
-- bundle installed before features existed, i.e. base only).
--
-- manual recovery if this fails partway:
--   ALTER TABLE bundles DROP COLUMN enabled_features;
--   DELETE FROM migrations WHERE name = 'platform::20260607-044-bundle-enabled-features.sql';

ALTER TABLE bundles
  ADD COLUMN enabled_features text[] NOT NULL DEFAULT '{}';
