alter table orgs add column if not exists time_zone text;

update orgs o
set time_zone = owner_zone.time_zone
from (
  select distinct on (m.org_id) m.org_id, u.time_zone
  from org_memberships m
  join users u on u.id = m.user_id
  where m.role = 'owner' and u.time_zone is not null
  order by m.org_id, m.joined_at, m.user_id
) owner_zone
where owner_zone.org_id = o.id and o.time_zone is null;
