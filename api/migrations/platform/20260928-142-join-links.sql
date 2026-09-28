-- A join link: one invite many people can use (#3801).
--
-- A club's storage closet has a QR on the wall. Anyone may take something and
-- must update the count, and the admin will not hand-make an account per
-- person. A workspace invite was single-use (`consumed_at` on the first
-- redemption), so the wall QR worked for exactly one member. A reusable
-- invite counts its uses instead of being consumed, may be capped, and says
-- who joined through it, so a leaked photo of the QR lets someone JOIN (where
-- the admin sees them and can remove them) and never write anything by itself.
alter table workspace_invites add column if not exists reusable boolean not null default false;
alter table workspace_invites add column if not exists max_uses integer;
alter table workspace_invites add column if not exists use_count integer not null default 0;

create table if not exists workspace_invite_uses (
  id          uuid primary key default gen_random_uuid(),
  invite_id   uuid not null references workspace_invites(id) on delete cascade,
  user_id     uuid not null references users(id) on delete cascade,
  new_account boolean not null default false,
  used_at     timestamptz not null default now()
);
create index if not exists workspace_invite_uses_invite_idx on workspace_invite_uses(invite_id, used_at desc);
