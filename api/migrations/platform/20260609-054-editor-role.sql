-- Add the 'editor' org role: the full builder shell + configuration + data CRUD,
-- but CANNOT manage members or delete the workspace (admin-minus-governance).
-- The role CHECK constraints on org_memberships + workspace_invites must accept
-- it. (Action gating is rank-based in code; member-management stays owner/admin
-- via ADMINISH and delete stays owner-only.)
--
-- manual recovery if this fails partway:
--   ALTER TABLE org_memberships DROP CONSTRAINT IF EXISTS org_memberships_role_check;
--   ALTER TABLE org_memberships ADD CONSTRAINT org_memberships_role_check
--     CHECK (role IN ('owner','admin','member','guest'));
--   (same for workspace_invites_role_check)
--   DELETE FROM migrations WHERE name = '20260609-054-editor-role.sql';

alter table org_memberships drop constraint if exists org_memberships_role_check;
alter table org_memberships
  add constraint org_memberships_role_check
  check (role in ('owner', 'admin', 'editor', 'member', 'guest'));

alter table workspace_invites drop constraint if exists workspace_invites_role_check;
alter table workspace_invites
  add constraint workspace_invites_role_check
  check (role in ('owner', 'admin', 'editor', 'member', 'guest'));
