-- Platform-level schema. Runs once on cobblr_meta. Owns the
-- cross-tenant entities: users, orgs, memberships, and the migration
-- tracker itself.
--
-- Migrations are immutable once merged. If this needs to change,
-- write a new numbered migration.

create extension if not exists "pgcrypto";

-- Users — one row per person. Email is the login identity. A user
-- can belong to many orgs via org_memberships; orgs are tenants.
create table users (
  id              uuid primary key default gen_random_uuid(),
  email           text not null unique,
  password_hash   text not null,
  display_name    text not null,
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  last_login_at   timestamptz
);

-- Orgs — tenants. Each org gets its own Postgres database
-- (`tenant_<short_uuid>`) provisioned in milestone 3; for milestone 2
-- the db_credentials_encrypted column is nullable since we're just
-- recording the intent. db_name is reserved at signup time.
create table orgs (
  id                          uuid primary key default gen_random_uuid(),
  name                        text not null,
  slug                        text not null unique,
  db_name                     text not null unique,
  db_credentials_encrypted    text,
  plan                        text not null default 'free'
                                check (plan in ('free', 'paid', 'disabled')),
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

create table org_memberships (
  user_id     uuid not null references users(id) on delete cascade,
  org_id      uuid not null references orgs(id) on delete cascade,
  role        text not null
                check (role in ('owner', 'admin', 'member', 'guest')),
  joined_at   timestamptz not null default now(),
  primary key (user_id, org_id)
);

create index org_memberships_org_idx on org_memberships(org_id);
create index org_memberships_user_idx on org_memberships(user_id);
