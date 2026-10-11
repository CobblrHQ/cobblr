-- The Vault (#5242): a workspace's folders of personal documents, each
-- readable only by the people its folder names. Additive.
--
-- A folder has one owner and an access list. Nobody else reaches it: not a
-- workspace admin, not search, not Cobb, not a share or a send. Its files are
-- stored encrypted with the workspace credential key (the secret fields'
-- crypto, db/crypto.ts encryptBytes): `ciphertext` is base64 of iv, tag and
-- ciphertext, so a backup carries it as it is and never decrypts it. Every
-- open, download, move and access change is a row of vault_events, which only
-- the folder's owner reads; the workspace activity log never names a vault
-- file, because everyone in the workspace can read that.
--
-- manual recovery if this fails partway:
--   DROP TABLE IF EXISTS vault_events, vault_files, vault_folder_members, vault_folders;
--   DELETE FROM migrations WHERE name = '20261011-215-vault.sql';

create table if not exists vault_folders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  name text not null,
  owner_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists vault_folders_org_idx on vault_folders (org_id);

create table if not exists vault_folder_members (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  folder_id uuid not null references vault_folders(id) on delete cascade,
  user_id uuid references users(id) on delete cascade,
  added_by uuid references users(id) on delete set null,
  added_at timestamptz not null default now(),
  unique (folder_id, user_id)
);
create index if not exists vault_folder_members_user_idx on vault_folder_members (org_id, user_id);

create table if not exists vault_files (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  folder_id uuid not null references vault_folders(id) on delete cascade,
  name text not null,
  mime_type text not null default 'application/octet-stream',
  size_bytes integer not null,
  key_id text not null,
  ciphertext text not null,
  -- The record this document belongs to (a car's registration), if any.
  record_kind text,
  record_id text,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists vault_files_folder_idx on vault_files (folder_id);
create index if not exists vault_files_record_idx on vault_files (org_id, record_kind, record_id) where record_id is not null;

create table if not exists vault_events (
  id bigserial primary key,
  org_id uuid not null references orgs(id) on delete cascade,
  folder_id uuid references vault_folders(id) on delete cascade,
  file_id uuid,
  file_name text,
  user_id uuid references users(id) on delete set null,
  action text not null,
  detail jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);
create index if not exists vault_events_folder_idx on vault_events (folder_id, at desc);
