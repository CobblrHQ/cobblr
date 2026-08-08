-- Field-level read-scope (H2): per-field capability gating layered on
-- the read trust boundary. Beyond the kind-level `exposable_fields`
-- whitelist, a kind can mark individual fields as requiring a
-- capability to read. The kernel's read projection
-- (applyExposableProjection) drops a gated field unless the viewer
-- holds the capability. Owner/admin and viewer-less internal/system
-- reads see everything; the member-facing views/portal read path passes
-- the viewer's effective capabilities, so members never over-see.
--
-- Enables tiered member access — Bjørn's "Tier 1 sees parts but not
-- prices; Tier 2 (granted inventory:view-costs) sees prices too." The
-- gating capability is a normal grantable action, so the admin assigns
-- it via the existing roles / permission matrix.
--
-- Shape: { "<field_name>": "<capability action_id>", ... }. Null/absent
-- = no per-field gating (current behaviour, fully backward-compatible).
-- Manifest-declared via `fieldReadScopes`; an admin-configurable
-- override layer is a planned follow-up.
--
-- See docs/architecture/entity-resolver.md (the trust boundary) and
-- docs/walkthroughs/bjorn-lego-user-flow.md (H2).
--
-- manual recovery if this fails partway:
--   ALTER TABLE entity_kinds DROP COLUMN field_read_scopes;
--   DELETE FROM migrations WHERE name = '20260529-034-field-read-scopes.sql';

alter table entity_kinds
  add column field_read_scopes jsonb;

comment on column entity_kinds.field_read_scopes is
  'Per-field read capability map { field_name: capability }. A gated field is omitted from reads unless the viewer holds the capability (owner/admin + viewer-less system reads see all). Null = no gating. See H2 / entity-resolver.md.';
