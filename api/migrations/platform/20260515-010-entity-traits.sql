-- Pillar A trait vocabulary persistence.
--
-- Each entity kind can declare where it sits on six orthogonal axes
-- (Tangibility, Identity, Containment, Time, Lifecycle, Persistence).
-- Module manifests carry the declarations; registry-sync writes the
-- resolved 6-tuple into this column on every boot. Cross-module
-- queries (action matching, wires UI, label translation) read from
-- here without needing to walk back to the manifest source.
--
-- Stored as jsonb of the shape:
--   { tangibility: "physical", identity: "unique",
--     containment: "containable", time: "timeless",
--     lifecycle: "indefinite", persistence: "durable" }
-- Skipped axes are absent (or null). Uncertain assignments render
-- as { trait: "unique", uncertain: true } in the same slot.
--
-- The `profile` column is bookkeeping: when a manifest used a
-- preset name (e.g. "owned-thing"), we keep the original name here
-- so tooling can render "Profile: owned-thing (= physical · ...)".
-- It's optional — raw-declared traits leave it null.
--
-- manual recovery if this fails partway:
--   ALTER TABLE entity_kinds DROP COLUMN IF EXISTS traits;
--   ALTER TABLE entity_kinds DROP COLUMN IF EXISTS profile;
--   DELETE FROM _prisma_migrations WHERE migration_name = '20260515-010-entity-traits';

alter table entity_kinds
  add column traits jsonb,
  add column profile text;
