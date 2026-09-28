-- Sign in to Cobblr from an AI assistant's connector (claude.ai and the Claude
-- phone apps), over the MCP authorization flow: OAuth 2.1, authorization code
-- with PKCE, dynamic client registration, rotating refresh tokens (#3803).
--
-- An access token is an ordinary api_tokens row held to one workspace and an
-- access level (20260928-137), minted for an hour, so every clamp a personal
-- token has applies to it unchanged. `grant_id` ties it to the connection a
-- person approved, and disconnecting revokes the lot.

create table if not exists oauth_clients (
  id            uuid primary key default gen_random_uuid(),
  client_id     text not null unique,
  client_name   text,
  redirect_uris text[] not null,
  created_at    timestamptz not null default now()
);

create table if not exists oauth_grants (
  id           uuid primary key default gen_random_uuid(),
  client_id    text not null references oauth_clients(client_id) on delete cascade,
  user_id      uuid not null references users(id) on delete cascade,
  org_id       uuid not null references orgs(id) on delete cascade,
  access       text not null check (access in ('look', 'change')),
  resource     text not null,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
create index if not exists oauth_grants_user_idx on oauth_grants(user_id);

-- A code is single-use, lives a minute, and is bound to its client, redirect,
-- PKCE challenge, resource, and the workspace + access the person chose.
create table if not exists oauth_codes (
  code_hash      text primary key,
  client_id      text not null references oauth_clients(client_id) on delete cascade,
  user_id        uuid not null references users(id) on delete cascade,
  org_id         uuid not null references orgs(id) on delete cascade,
  access         text not null check (access in ('look', 'change')),
  redirect_uri   text not null,
  code_challenge text not null,
  resource       text not null,
  expires_at     timestamptz not null,
  used_at        timestamptz
);

-- Rotating: each refresh spends its token and issues a new one. A spent one
-- used again means it was copied, and the whole grant is revoked.
create table if not exists oauth_refresh_tokens (
  token_hash text primary key,
  grant_id   uuid not null references oauth_grants(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at    timestamptz
);
create index if not exists oauth_refresh_tokens_grant_idx on oauth_refresh_tokens(grant_id);

alter table api_tokens add column if not exists grant_id uuid references oauth_grants(id) on delete cascade;
create index if not exists api_tokens_grant_idx on api_tokens(grant_id) where grant_id is not null;
