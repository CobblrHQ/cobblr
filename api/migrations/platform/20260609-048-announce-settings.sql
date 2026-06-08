-- Platform announcements → Discord. Per-category toggle + optional channel
-- override, super-admin-configurable. Generalizes the old single-webhook
-- "new feedback" ping (COBBLR_FEEDBACK_DISCORD_WEBHOOK) into a small routing
-- table so we can post feedback resolutions, bundle releases, feature updates,
-- etc. — each independently toggleable (so it never doubles up with, say, a
-- separate git-commit feed).
--
-- webhook_url NULL => fall back to COBBLR_FEEDBACK_DISCORD_WEBHOOK (the default
-- channel). enabled=false => never post that category.
--
-- manual recovery if this fails partway:
--   drop table if exists platform_announce_settings;
--   delete from migrations where name = '20260609-048-announce-settings.sql';

create table platform_announce_settings (
  category    text primary key,
  enabled     boolean not null default true,
  webhook_url text,
  updated_at  timestamptz not null default now()
);
