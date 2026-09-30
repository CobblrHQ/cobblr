-- Connections of kind `service` (docs/design-decisions/services.md §6).
--
-- A service connection is an ordinary personal connection: `user_credentials`
-- holds it (kind 'service', provider_id = the manifest id, credentials =
-- {base_url, transit, secret}) and `user_credential_orgs` its per-workspace
-- routes and its rank per capability. Nothing new for the connection itself.
--
-- 1. The capability column now holds two id spaces, AI's (`identify-image`,
--    `chat`) and a service's (`slice.model`, `design.part`). They must never
--    collide: a service capability always contains a dot, an AI capability
--    never does. The service shape is the manifest validator's own
--    (SERVICE_CAPABILITY_ID in @cobblr/platform-contract/services), so the
--    column never refuses an id a valid manifest declares. This CHECK holds the shape of both, so a malformed id cannot
--    be ranked at all; the manifest validator refuses an undotted service
--    capability, and setMyConnectionOrder refuses a dotted id on an AI
--    connection and an undotted one on a service.
--
-- 2. The manifest a service published, cached per connection. A route row
--    should not carry a document, and a job reporting a newer
--    manifest_version (the sha256 of the manifest's bytes) makes Cobblr read
--    it again.
--
-- Additive: every value written today is an AI capability of the undotted
-- shape, and the constraint is validated separately so a stray row fails the
-- migration by name rather than half-applying it.
--
-- manual recovery if this fails partway:
--   ALTER TABLE user_credential_orgs DROP CONSTRAINT IF EXISTS user_credential_orgs_capability_shape;
--   DROP TABLE IF EXISTS service_manifests;
--   DELETE FROM migrations WHERE name = '20260929-156-service-connections.sql';

alter table user_credential_orgs drop constraint if exists user_credential_orgs_capability_shape;
alter table user_credential_orgs add constraint user_credential_orgs_capability_shape check (
  capability is null
  or capability ~ '^[a-z][a-z0-9-]*$'
  or capability ~ '^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$'
) not valid;
alter table user_credential_orgs validate constraint user_credential_orgs_capability_shape;

create table if not exists service_manifests (
  credential_id uuid primary key references user_credentials(id) on delete cascade,
  manifest jsonb not null,
  manifest_version text not null,
  etag text,
  fetched_at timestamptz not null default now()
);
