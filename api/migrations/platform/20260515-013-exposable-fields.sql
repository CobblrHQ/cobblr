-- Phase 1: kernel-side `exposableFields` whitelist.
--
-- The read-time trust boundary: when one module's renderer looks up
-- another module's entity via platform.entities.lookup(), the kernel
-- projects the resolved fields down to this whitelist. Names not on
-- the list are private to the owning module.
--
-- Null = legacy behaviour (full ResolvedEntity.fields returned, with
-- a one-time deprecation warning logged per kind on first cross-module
-- read). All new modules SHOULD declare exposableFields in their
-- manifest. Existing modules will get them filled in incrementally.
--
-- See:
--   docs/architecture/entity-resolver.md — the trust boundary
--   docs/architecture/manifest-contract.md — manifest field spec
--   docs/product/build-plan.md — Phase 1

alter table entity_kinds
  add column exposable_fields jsonb;

comment on column entity_kinds.exposable_fields is
  'Cross-module read whitelist. Null = legacy (full fields, deprecation logged). Array = field names other modules may read via platform.entities.lookup(). Implicit cross-cutting props (id/title/subtitle/image_path/detailUrl) are always exposable.';
