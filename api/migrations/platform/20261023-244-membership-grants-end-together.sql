-- Grants belong to a membership, so leaving and rejoining starts without old access.
-- Existing writers verify membership before granting access; columns and reads stay the same.
--
-- manual recovery if this fails partway:
--   alter table workspace_role_assignments drop constraint if exists workspace_role_assignments_membership_fk;
--   alter table workspace_capability_grants drop constraint if exists workspace_capability_grants_membership_fk;
--   DELETE FROM migrations WHERE name = '20261023-244-membership-grants-end-together.sql';
-- Removed orphan permissions must be granted again rather than restored.

lock table org_memberships, workspace_role_assignments, workspace_capability_grants
  in share row exclusive mode;

delete from workspace_role_assignments as a
where not exists (
  select 1 from org_memberships as m
  where m.user_id = a.user_id and m.org_id = a.org_id
);

delete from workspace_capability_grants as g
where not exists (
  select 1 from org_memberships as m
  where m.user_id = g.user_id and m.org_id = g.org_id
);

alter table workspace_role_assignments
  add constraint workspace_role_assignments_membership_fk
  foreign key (user_id, org_id) references org_memberships (user_id, org_id)
  on delete cascade;

alter table workspace_capability_grants
  add constraint workspace_capability_grants_membership_fk
  foreign key (user_id, org_id) references org_memberships (user_id, org_id)
  on delete cascade;
