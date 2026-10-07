-- Sandboxes an operator made from the box (scripts/try-sandbox.sh), and why.
--
-- The public door (/try/start) is a stranger behind a captcha; an operator
-- walking the sandbox to check it is not a stranger, and must not be counted
-- as one, announced as one, or made to solve the challenge. This is the
-- audit of each such mint (who, why, when, until when) and the list stats
-- read to leave those workspaces out.
--
-- No foreign key to orgs: a sandbox is reaped when its hour ends and its org
-- row goes with it, and the record of who made it, and why, must outlive it.
-- Its events keep the org id, so the exclusion holds for them too.
--
-- Additive: a new table.
--
-- manual recovery if this fails partway:
--   DROP TABLE IF EXISTS operator_sandboxes;
--   DELETE FROM migrations WHERE name = '20261006-202-operator-sandboxes.sql';

create table if not exists operator_sandboxes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  slug text not null,
  operator_user_id uuid not null,
  operator_email text not null,
  reason text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists operator_sandboxes_org on operator_sandboxes (org_id);
