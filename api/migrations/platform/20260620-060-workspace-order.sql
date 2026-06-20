-- Per-user ordering of the workspace switcher. Until now GET /me returned a
-- user's workspaces with NO `order by`, so Postgres' physical order leaked
-- through and any membership write could visibly reshuffle the switcher. Give
-- each membership a `position`: GET /me orders by it, and
-- PATCH /me/workspaces/order rewrites it (drag-to-reorder). Backfill
-- deterministically by joined_at so existing switchers don't jump on deploy.
--
-- manual recovery if this fails partway:
--   ALTER TABLE org_memberships DROP COLUMN position;
--   DELETE FROM migrations WHERE name = '20260620-060-workspace-order.sql';

alter table org_memberships add column position integer not null default 0;

update org_memberships m
set position = sub.rn
from (
  select user_id, org_id,
         (row_number() over (partition by user_id order by joined_at asc, org_id asc) - 1) as rn
  from org_memberships
) sub
where m.user_id = sub.user_id and m.org_id = sub.org_id;
