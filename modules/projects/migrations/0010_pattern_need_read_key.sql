-- Which line of a pattern's read each requirement came from (#5900), so Read
-- again merges by identity: a requirement the person corrected (or picked a
-- yarn for, or finished) is never made again beside itself. A yarn or tool
-- is its kind and its order within that kind in the read; a notion is its
-- name. Rows read before this are given the key their read would give them.

alter table projects_pattern_needs
  add column read_key text;

update projects_pattern_needs n
set read_key = k.read_key
from (
  select id,
         case when kind = 'notion' then 'notion:' || lower(coalesce(label, ''))
              else kind || ':' || (row_number() over (partition by project_id, kind order by position) - 1)
         end as read_key
  from projects_pattern_needs
  where source in ('pattern', 'ai')
) k
where n.id = k.id;
