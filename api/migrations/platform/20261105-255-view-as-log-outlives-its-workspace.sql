-- The View as log and the console's deletes outlive the workspace (#9234).
--
-- impersonation_sessions cascaded on its workspace's delete, so removing a
-- workspace also removed the record of who had looked inside it and why, at
-- the moment that record mattered most. The row now keeps the workspace's id,
-- and a snapshot of its name and address taken when it is deleted, and no
-- workspace data. operator_actions records what an operator removed from the
-- console. Both are kept for a year (operator-log-retention.ts).
--
-- PHASE: contract
-- SAFE WHEN: dropping the foreign key removes a cascade and adds no rule, so an
-- api from before this deletes a workspace exactly as it did and its View as
-- rows simply stay; no reader joins these rows to require the workspace (the
-- console's log left-joins orgs, and this change moves the CLI's log to a left
-- join in the same release).
alter table impersonation_sessions drop constraint if exists impersonation_sessions_org_id_fkey;
alter table impersonation_sessions add column if not exists workspace_name text;
alter table impersonation_sessions add column if not exists workspace_slug text;

create table if not exists operator_actions (
  id uuid primary key default gen_random_uuid(),
  operator_user_id uuid not null,
  action text not null,
  subject_kind text not null,
  subject_id uuid not null,
  subject_name text,
  created_at timestamptz not null default now()
);
create index if not exists operator_actions_created_idx on operator_actions (created_at desc);
