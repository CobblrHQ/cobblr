-- A sandbox kept with an address that already keeps a trial on this box joins
-- that account as another workspace, and only once the address says yes: the
-- link in its inbox is the consent. One row per pending join. The token is
-- stored hashed (sha256), single use, and dies with the sandbox.
create table if not exists try_keep_joins (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references orgs(id) on delete cascade,
  account_user_id  uuid not null references users(id) on delete cascade,
  guest_user_id    uuid not null,
  token_hash       text not null unique,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  consumed_at      timestamptz
);

create index if not exists try_keep_joins_org_idx on try_keep_joins (org_id);
