-- Personal (user-scoped) connections — a credential a user configures ONCE and
-- routes to chosen workspaces, so their BYO AI keys / local-AI edge bridge
-- FOLLOW them instead of being re-added per workspace. Lives in cobblr_meta
-- (keyed by user); projected into a workspace's AI provider resolution by the
-- routing policy below. Single source of truth → revoke is instant.
--
-- credentials_encrypted: AES-256-GCM (global key, db/crypto.ts), a JSON object.
-- route_mode:
--   'my-calls'          → used ONLY for calls THIS user personally initiates
--                         (leak-free: never touches a co-member or a wire).
--   'workspace-default' → used for ANY caller / automation in the workspace
--                         (fuller, but shares — bounded by route_scope).
-- route_scope (which of the user's workspaces a route reaches):
--   'sole_member'  → only workspaces where this user is the ONLY member (safe).
--   'owner'        → workspaces where this user is owner.
--   'all_mine'     → every workspace this user belongs to.
--   'explicit'     → exactly the workspaces in user_credential_orgs.
-- auto_enable_new: for 'explicit', auto-add newly created workspaces.
--
-- Defaults (my-calls + sole_member) are the SAFEST: a new personal cred can
-- only affect its owner, in workspaces only they inhabit, until widened.
--
-- manual recovery if this fails partway:
--   DROP TABLE IF EXISTS user_credential_orgs;
--   DROP TABLE IF EXISTS user_credentials;
--   DELETE FROM migrations WHERE name = '20260609-053-user-credentials.sql';

create table user_credentials (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references users(id) on delete cascade,
  kind                  text not null default 'ai-provider',
  provider_id           text not null,
  label                 text not null default '',
  credentials_encrypted text not null,
  route_mode            text not null default 'my-calls',
  route_scope           text not null default 'sole_member',
  auto_enable_new       boolean not null default false,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index user_credentials_user_idx on user_credentials(user_id);

create table user_credential_orgs (
  credential_id uuid not null references user_credentials(id) on delete cascade,
  org_id        uuid not null references orgs(id) on delete cascade,
  primary key (credential_id, org_id)
);
create index user_credential_orgs_org_idx on user_credential_orgs(org_id);
