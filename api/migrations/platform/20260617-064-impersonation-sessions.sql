-- Operator impersonation ("View as"). An auditable, time-boxed grant for a
-- platform operator to render a workspace AS one of its members for support.
-- The operator's identity is NEVER replaced — it rides every request in the
-- impersonation token's `sub`; this row is the server-side session (revocable,
-- expiring) the token points at. Read-only by default; `mode='write'` is a
-- deliberate, separately-audited escalation. Append-only except ended_at / mode /
-- request_count. See docs/modules/operator-impersonation.md.
--
-- manual recovery if this fails partway:
--   drop table if exists impersonation_sessions;
--   delete from migrations where name = '20260617-064-impersonation-sessions.sql';

create table impersonation_sessions (
  id                uuid primary key default gen_random_uuid(),
  operator_user_id  uuid not null references users(id),
  target_user_id    uuid not null references users(id),
  org_id            uuid not null references orgs(id) on delete cascade,
  reason            text not null,
  -- 'read' (default, safe) | 'write' (deliberate, toggled in-session, audited).
  mode              text not null default 'read',
  request_count     integer not null default 0,
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null,
  -- when the operator first armed write mode this session (audit; null = never).
  write_enabled_at  timestamptz,
  -- set when ended early (Exit) — a non-null ended_at invalidates the token.
  ended_at          timestamptz
);

-- The console "Impersonation log" lists newest-first; the middleware looks up a
-- live session by id on every impersonated request.
create index impersonation_sessions_created_idx on impersonation_sessions (created_at desc);
create index impersonation_sessions_org_idx on impersonation_sessions (org_id);
