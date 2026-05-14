-- Platform-level primitives that every module gets to use:
-- tags, activity_log, notifications + subscriptions. All scoped by
-- org_id so different tenants stay isolated.
--
-- These live in cobblr_meta (not in per-tenant DBs) for two reasons:
--   1. Cross-module tag queries ("everything tagged 'klipper'")
--      need one source of truth, not N tenant DBs aggregated.
--   2. The platform owns these tables — modules read/write through
--      the platform API, never via direct SQL.

-- ─────────────────────────── tags ────────────────────────────────

create table tags (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references orgs(id) on delete cascade,
  name        text not null,
  color       text,
  created_at  timestamptz not null default now(),
  unique (org_id, name)
);

create index tags_org_idx on tags(org_id);

-- Polymorphic attachment: a tag points at (module, entity_type, entity_id).
-- entity_id is text so modules with non-uuid PKs (int4, slug, etc.)
-- still fit. The (module_name, entity_type, entity_id) triple is the
-- only stable address across the platform.
create table tag_assignments (
  tag_id        uuid not null references tags(id) on delete cascade,
  module_name   text not null,
  entity_type   text not null,
  entity_id     text not null,
  attached_at   timestamptz not null default now(),
  primary key (tag_id, module_name, entity_type, entity_id)
);

create index tag_assignments_entity_idx
  on tag_assignments(module_name, entity_type, entity_id);

-- ────────────────────────── activity_log ──────────────────────────
--
-- Append-only audit trail. Every CRUD that matters routes through
-- platform.activity.log() and lands here. We keep the diff in JSONB
-- for grep-friendliness later.

create table activity_log (
  id            bigserial primary key,
  org_id        uuid not null references orgs(id) on delete cascade,
  user_id       uuid references users(id) on delete set null,
  -- null module_name = platform-level action (org_created, etc.).
  module_name   text,
  action        text not null,
  entity_type   text not null,
  entity_id     text not null,
  diff          jsonb,
  occurred_at   timestamptz not null default now()
);

create index activity_log_org_time_idx
  on activity_log(org_id, occurred_at desc);
create index activity_log_entity_idx
  on activity_log(module_name, entity_type, entity_id);

-- ────────────────────────── notifications ─────────────────────────
--
-- Every dispatched notification is logged here regardless of which
-- channels delivered it. delivered_via is an array of channel names
-- ("in_app", "browser_push", "email", etc.) so a single row tracks
-- the full fan-out.

create table notifications (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references orgs(id) on delete cascade,
  user_id       uuid not null references users(id) on delete cascade,
  event_type    text not null,
  module_name   text,
  entity_type   text,
  entity_id     text,
  message       text not null,
  link_url      text,
  delivered_via text[] not null default '{}',
  read_at       timestamptz,
  created_at    timestamptz not null default now()
);

create index notifications_user_unread_idx
  on notifications(user_id, read_at) where read_at is null;
create index notifications_org_time_idx
  on notifications(org_id, created_at desc);

create table notification_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  org_id      uuid not null references orgs(id) on delete cascade,
  event_type  text not null,
  channel     text not null
                check (channel in ('in_app', 'browser_push', 'email', 'discord', 'webhook', 'slack')),
  enabled     boolean not null default true,
  config      jsonb,
  unique (user_id, org_id, event_type, channel)
);

create index notification_subscriptions_lookup_idx
  on notification_subscriptions(user_id, org_id, event_type);
