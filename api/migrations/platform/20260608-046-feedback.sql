-- User feedback about the platform itself (bugs / confusion / ideas). Cross-tenant
-- and platform-level: any authenticated user can submit from any workspace, and
-- only super-admins triage. Lands in a queue (status) reviewable from /super-admin.
-- Distinct from anything workspace-scoped — this is feedback about Cobblr.
--
-- manual recovery if this fails partway:
--   DROP TABLE IF EXISTS feedback;
--   DELETE FROM migrations WHERE name = '20260608-046-feedback.sql';

create table feedback (
  id          uuid primary key default gen_random_uuid(),
  -- who submitted (always authenticated) + which workspace they were in (best-effort)
  user_id     uuid not null references users(id),
  org_id      uuid references orgs(id),
  -- bug | confusing | idea | other
  type        text not null default 'bug',
  message     text not null,
  -- auto-captured context: { url, route, userAgent, viewport, build, ... }
  context     jsonb not null default '{}'::jsonb,
  -- triage queue: new | triaged | in_progress | resolved | wontfix
  status      text not null default 'new',
  admin_notes text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- triage is "show me the new ones, newest first"
create index feedback_status_idx on feedback(status, created_at desc);
