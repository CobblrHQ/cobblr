-- core-calendar iCal feed tokens. Lives in cobblr_meta (not a tenant DB)
-- because the public feed route GET /api/v1/calendar/:token.ics has no org
-- context — it resolves token → org here, like public_surfaces tokens.
-- One feed per workspace; the token is a long random slug, rotatable.
--
-- manual recovery if this fails partway:
--   DROP TABLE IF EXISTS calendar_feeds;
--   DELETE FROM migrations WHERE name = '20260603-039-calendar-feeds.sql';

create table calendar_feeds (
  org_id      uuid primary key references orgs(id) on delete cascade,
  token       text not null unique,
  enabled     boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index calendar_feeds_token_idx on calendar_feeds(token);
