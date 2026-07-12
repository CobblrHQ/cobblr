-- Per-kind labeling hint: the DEFAULT for drawing the human-readable code in
-- the QR center, declared by the owning module (`labelCodeOverlayDefault`).
-- The `labels` module reads this generically off the entity-kind registry to
-- pick a default when a workspace hasn't set an explicit per-kind toggle —
-- rather than branching on any kind string (module isolation). Null = the
-- kind didn't declare one; labels treats null/absent as true (today's
-- behavior), so this is fully additive and self-heals existing installs.
--
-- A location declares `false` (name-unique — one "Office" — so a
-- disambiguating code is noise); parts/machines/etc. keep it on. A user's
-- explicit toggle still wins over this default. See label-codes.md.
--
-- manual recovery if this fails partway:
--   ALTER TABLE entity_kinds DROP COLUMN label_code_overlay_default;
--   DELETE FROM migrations WHERE name = '20260712-083-entity-kind-label-code-overlay-default.sql';

alter table entity_kinds
  add column label_code_overlay_default boolean;

comment on column entity_kinds.label_code_overlay_default is
  'Owning module''s default for drawing the label code in the QR center (labelCodeOverlayDefault). Read generically by the labels module; null = undeclared (treated as true). A user''s explicit per-kind toggle overrides it. See label-codes.md.';
