-- One row per account email the platform actually sent (notifyAccount's email
-- channel): who, which notification type, when, and whether it carried the
-- Discord invitation. Two questions read it, so there is one record of the
-- send instead of a counter beside it:
--   - how many feedback emails went out each week (the point of the Discord
--     invitation is to send fewer);
--   - how many times a person has been shown the invitation, which stops after
--     three.
-- Written only after the sender said yes, so a failed send counts for nothing.
--
-- manual recovery if this fails partway:
--   drop table if exists account_email_sends;
--   delete from migrations where name = '20260930-172-account-email-sends.sql';

create table if not exists account_email_sends (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references users(id) on delete cascade,
  notification_type  text not null,
  discord_invite     boolean not null default false,
  sent_at            timestamptz not null default now()
);

create index if not exists account_email_sends_type_idx on account_email_sends (notification_type, sent_at);
create index if not exists account_email_sends_invite_idx on account_email_sends (user_id) where discord_invite;
