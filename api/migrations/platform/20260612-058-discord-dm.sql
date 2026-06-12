-- Discord DM notification channel + account-level Communication Preferences
-- (Feature 1). Two tables:
--   • discord_connections — a user's verified Discord identity (account-level,
--     one per user), populated by the OAuth `identify` flow and confirmed by a
--     verified test DM before the channel is ever relied on.
--   • notification_account_prefs — the account-level preferences matrix
--     (notification_type × channel), SEPARATE from the per-workspace
--     notification_subscriptions used for module/workspace events. Platform
--     notifications (feedback replies, announcements, Claude messages) are
--     account-level, so their channel choice lives here.
--
-- manual recovery if this fails partway:
--   DROP TABLE IF EXISTS notification_account_prefs;
--   DROP TABLE IF EXISTS discord_connections;
--   DELETE FROM migrations WHERE name = '20260612-058-discord-dm.sql';

create table discord_connections (
  user_id            uuid primary key references users(id) on delete cascade,
  discord_user_id    text,
  discord_username   text,
  verified           boolean not null default false,
  -- single-use secret the test-DM button / website fallback presents to verify
  verify_token       text,
  verify_expires_at  timestamptz,
  connected_at       timestamptz,           -- when the OAuth link was made
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
-- resolve a pending verification by its unguessable single-use token
create unique index discord_conn_verify_token_uq
  on discord_connections (verify_token) where verify_token is not null;
-- one Discord identity maps to at most one *verified* Cobblr user
create unique index discord_conn_discord_user_uq
  on discord_connections (discord_user_id) where discord_user_id is not null and verified;

create table notification_account_prefs (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references users(id) on delete cascade,
  notification_type  text not null,        -- e.g. platform.feedback.replied
  channel            text not null,        -- in_app | email | discord_dm
  enabled            boolean not null default true,
  updated_at         timestamptz not null default now(),
  unique (user_id, notification_type, channel)
);
create index notif_acct_prefs_user_idx on notification_account_prefs (user_id);
