-- Add the 'operator' org role (#6672): a member who runs the machines. It
-- starts, sends, pauses, resumes, stops and frames jobs, confirms stock at a
-- station and records outcomes, through the capabilities a module declares
-- held by it; it cannot set up connections, stations, people or settings.
-- The role CHECK constraints on org_memberships + workspace_invites must
-- accept it. Nobody is moved into it: an admin assigns it.
--
-- manual recovery if this fails partway:
--   ALTER TABLE org_memberships DROP CONSTRAINT IF EXISTS org_memberships_role_check;
--   ALTER TABLE org_memberships ADD CONSTRAINT org_memberships_role_check
--     CHECK (role IN ('owner','admin','editor','member','guest'));
--   (same for workspace_invites_role_check)
--   DELETE FROM migrations WHERE name = '20261015-225-operator-role.sql';

alter table org_memberships drop constraint if exists org_memberships_role_check;
alter table org_memberships
  add constraint org_memberships_role_check
  check (role in ('owner', 'admin', 'editor', 'operator', 'member', 'guest'));

alter table workspace_invites drop constraint if exists workspace_invites_role_check;
alter table workspace_invites
  add constraint workspace_invites_role_check
  check (role in ('owner', 'admin', 'editor', 'operator', 'member', 'guest'));
