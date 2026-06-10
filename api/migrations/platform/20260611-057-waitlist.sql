-- Waitlist signups from the marketing site (cobblr.xyz). The Cloudflare Pages
-- Function forwards each form submission here (scoped waitlist:ingest token);
-- a platform admin reviews them in the super-admin Waitlist tab and approves
-- (mints a signup_invite, optionally emailed) or dismisses.
--
-- manual recovery if this fails partway:
--   DROP TABLE IF EXISTS waitlist;
--   DELETE FROM migrations WHERE name = '20260611-057-waitlist.sql';

create table waitlist (
  id            uuid primary key default gen_random_uuid(),
  email         text not null,
  source        text not null default 'marketing-site',
  user_agent    text,
  signed_up_at  timestamptz,                   -- when they submitted the form (caller-supplied)
  status        text not null default 'pending', -- pending | invited | dismissed
  invite_id     uuid references signup_invites(id),
  decided_at    timestamptz,
  decided_by    uuid references users(id),
  created_at    timestamptz not null default now()
);

-- one PENDING row per email — repeat signups are idempotent, but someone
-- dismissed/invited earlier may legitimately sign up again later
create unique index waitlist_email_pending_uq on waitlist (lower(email)) where status = 'pending';
create index waitlist_status_idx on waitlist (status, created_at desc);
