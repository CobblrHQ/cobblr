-- Folders for files (#3753 P2): a place a file lives, nested, as a person
-- arranges them ("Patterns / Blankets"). Additive: a file with no folder
-- is at the top, which is every file that existed before this.
--
-- A folder never takes its files with it. Deleting a folder is refused
-- while it holds anything (the route says so), and if a row goes some
-- other way the files fall back to the top (on delete set null) rather
-- than vanishing.

create table if not exists core_files_folders (
  id          uuid primary key default gen_random_uuid(),
  parent_id   uuid references core_files_folders(id) on delete restrict,
  name        text not null check (length(btrim(name)) between 1 and 120),
  created_at  timestamptz not null default now()
);

-- One name per level, case-insensitively, the top level included.
create unique index if not exists core_files_folders_name_idx
  on core_files_folders (coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(btrim(name)));

alter table core_files_files
  add column if not exists folder_id uuid references core_files_folders(id) on delete set null;

create index if not exists core_files_files_folder_idx
  on core_files_files (folder_id) where deleted_at is null;
