-- Admin-configurable field read-scope (H2 extension) — "Bjørn defines
-- his own tiers." The manifest-declared entity_kinds.field_read_scopes
-- (e.g. the lego bundle gating `cost`) is the default; this table lets a
-- workspace ADMIN mark ANY field of ANY kind sensitive and bind it to a
-- capability, per workspace. Merged with the manifest scopes at read
-- time (per-org entries win), and the capability is auto-grantable so it
-- shows up in the permission matrix like any other.
--
-- One row = one gated field for one workspace. Meta-side (an
-- auth/identity concern, like workspace_capability_grants), keyed by
-- (org_id, kind) for the per-read lookup.
--
-- manual recovery if this fails partway:
--   DROP TABLE IF EXISTS workspace_field_scopes;
--   DELETE FROM migrations WHERE name = '20260529-035-workspace-field-scopes.sql';

create extension if not exists "pgcrypto";

create table workspace_field_scopes (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references orgs(id) on delete cascade,
  kind        text not null,
  field       text not null,
  capability  text not null,
  created_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now(),
  unique (org_id, kind, field)
);

create index workspace_field_scopes_org_kind_idx
  on workspace_field_scopes(org_id, kind);
