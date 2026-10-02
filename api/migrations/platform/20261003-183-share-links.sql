-- Sharing part of a workspace with someone, possibly on another Cobblr
-- (#4627, docs/design-decisions/share-spaces.md). Additive.
--
-- A share space is a workspace of its own (kind 'share') on the friend's
-- instance. The owner's workspace reaches it through a link: a row on each
-- side, paired at invite and accept, each holding the key it signs with and
-- the key it checks the other side's requests against (encrypted). What one
-- side tells the other waits in an ordered outbox until it is delivered, and
-- the receiving side keeps the key of every change it applied, so a repeat
-- delivery applies nothing twice.

alter table orgs add column if not exists kind text not null default 'workspace';

create table if not exists share_links (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  side text not null check (side in ('owner', 'share')),
  status text not null default 'pending' check (status in ('pending', 'active', 'revoked')),
  -- The other Cobblr's address; null when both sides are on this one.
  peer_url text,
  peer_link_id uuid,
  peer_name text,
  peer_workspace_name text,
  label text,
  send_key_encrypted text,
  receive_key_id text,
  receive_secret_encrypted text,
  invite_code_hash text,
  invite_expires_at timestamptz,
  created_by uuid references users(id) on delete set null,
  peer_version integer,
  last_synced_at timestamptz,
  last_error text,
  last_error_at timestamptz,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index if not exists share_links_org_idx on share_links (org_id);
create unique index if not exists share_links_receive_key_idx on share_links (receive_key_id) where receive_key_id is not null;
create unique index if not exists share_links_invite_idx on share_links (invite_code_hash) where invite_code_hash is not null;

create table if not exists share_outbox (
  id bigserial primary key,
  link_id uuid not null references share_links(id) on delete cascade,
  key text not null,
  op text not null,
  payload jsonb not null,
  attempts integer not null default 0,
  next_at timestamptz not null default now(),
  sent_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  unique (link_id, key)
);
create index if not exists share_outbox_due_idx on share_outbox (link_id, id) where sent_at is null;

create table if not exists share_received (
  link_id uuid not null references share_links(id) on delete cascade,
  key text not null,
  received_at timestamptz not null default now(),
  primary key (link_id, key)
);

create table if not exists share_nonces (
  key_id text not null,
  nonce text not null,
  seen_at timestamptz not null default now(),
  primary key (key_id, nonce)
);
