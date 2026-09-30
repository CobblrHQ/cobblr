-- "Download my data": a person's own copy of what Cobblr holds about them
-- (account, memberships, token and connection metadata, notification
-- settings, what they did, what they sent us). One row per request; the file
-- is kept for seven days and only its owner can fetch it.
create table if not exists personal_exports (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  status       text not null default 'building',
  error        text,
  bytes        bytea,
  size_bytes   integer,
  created_at   timestamptz not null default now(),
  ready_at     timestamptz,
  expires_at   timestamptz not null
);

create index if not exists personal_exports_user_idx on personal_exports (user_id, created_at desc);
