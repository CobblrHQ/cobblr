-- Retention requests for kept item photos, waiting to reach the shared network
-- (api/src/platform/photo-retention.ts, CobblrHQ/core#3769). One row per
-- person: `unlink` when their account was deleted, `forget` when they asked
-- for their photos to be deleted. The row holds only the opaque actor id the
-- photos were filed under, never the user id, and goes as soon as the network
-- confirms. Written here first so an unreachable network delays the request
-- instead of losing it.
--
-- manual recovery if this fails partway:
--   DROP TABLE IF EXISTS photo_retention_pending;
--   DELETE FROM migrations WHERE name = '20260927-136-photo-retention-pending.sql';

create table if not exists photo_retention_pending (
  actor       text        primary key,
  kind        text        not null check (kind in ('unlink', 'forget')),
  attempts    int         not null default 0,
  last_error  text,
  next_at     timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

create index if not exists photo_retention_pending_due on photo_retention_pending (next_at);
