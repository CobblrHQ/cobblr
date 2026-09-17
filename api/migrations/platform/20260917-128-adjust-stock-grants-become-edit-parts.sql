-- POST /parts/:id/stock-adjust gates on "Edit parts" (inventory:update-part)
-- now, not on inventory:adjust-stock, the wire-fired action that is
-- deliberately not grantable (lint:capability-gates-grantable). Until
-- 2026-07 the permissions matrix offered the entire action registry, so a
-- workspace may hold an explicit inventory:adjust-stock grant or a custom
-- role carrying it; without this, that person would lose the door the day
-- the route changed. Every such holder gets Edit parts too. The old rows
-- stay: they gate nothing and dropping them is not this migration's job.
insert into workspace_capability_grants (org_id, user_id, action_id, granted_by)
select org_id, user_id, 'inventory:update-part', granted_by
from workspace_capability_grants
where action_id = 'inventory:adjust-stock'
on conflict (org_id, user_id, action_id) do nothing;

insert into workspace_role_capabilities (role_id, action_id)
select role_id, 'inventory:update-part'
from workspace_role_capabilities
where action_id = 'inventory:adjust-stock'
on conflict do nothing;

-- manual recovery: none needed; the rows added are ordinary grants an admin
-- can revoke in the matrix.
