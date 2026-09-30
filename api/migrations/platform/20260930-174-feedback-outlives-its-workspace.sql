-- A workspace that has filed feedback can be deleted, and its report stays.
--
-- feedback.org_id referenced orgs(id) with no ON DELETE, so deleting a
-- workspace that had ever filed a report failed on the foreign key (a 500).
-- The operator keeps the report: the workspace's id is cleared and its name
-- kept as text, so the queue still says where it came from.
--
-- The constraint is replaced by the same reference with ON DELETE SET NULL.
-- For a running api this only loosens what it could already do (org_id was
-- always nullable), so an older api reading or writing feedback is unaffected.

alter table feedback add column if not exists workspace_name text;

alter table feedback drop constraint if exists feedback_org_id_fkey;
alter table feedback
  add constraint feedback_org_id_fkey foreign key (org_id) references orgs(id) on delete set null;
