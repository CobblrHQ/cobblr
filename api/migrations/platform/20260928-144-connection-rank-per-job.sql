-- A connection's order for ONE kind of work could never be saved.
--
-- 20260821-107 gave user_credential_orgs a `capability` column so a workspace
-- could order its connections per job (a fast model for the camera, a better
-- one for chat), stored as extra rows beside the route's general row. But the
-- table's primary key was (credential_id, org_id), so the second row for the
-- same connection and workspace was always a duplicate key: every per-job
-- order failed with a 500, and the router only ever saw the general order.
--
-- The key moves to a surrogate id. One GENERAL row per (credential,
-- workspace) is still guaranteed, by a partial unique index; per-job rows
-- stay unique through the index 107 already made.
--
-- PHASE: contract
-- SAFE WHEN: nothing writes this table with ON CONFLICT (checked: no
-- onConflict on user_credential_orgs anywhere in api/src or modules), so an
-- api that predates this reads and writes it unchanged; the primary key held
-- one row per (credential_id, org_id), so the new unique index builds on
-- existing data without a duplicate.
alter table user_credential_orgs add column if not exists id uuid not null default gen_random_uuid();
alter table user_credential_orgs drop constraint if exists user_credential_orgs_pkey;
alter table user_credential_orgs add primary key (id);
create unique index if not exists user_credential_orgs_general_uniq
  on user_credential_orgs (credential_id, org_id)
  where capability is null;
