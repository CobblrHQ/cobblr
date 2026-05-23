-- core-files — file storage with image variant generation. Foundational.
--
-- Two tables (both prefixed `core_files_` per the manifest's
-- tablePrefix to match sibling-module conventions):
--   core_files_files        metadata for uploaded blobs. The bytes
--                           live on the filesystem under
--                           <COBBLR_FILES_ROOT>/<orgId>/<fileId>/.
--                           variants is a JSON map: original + (for
--                           images) medium + thumb, each with relative
--                           path + bytes.
--   core_files_attachments  polymorphic "this file is the X of that
--                           entity" — same (source_module,
--                           source_type, source_id) shape as
--                           entity_pairings, so a future resolver
--                           could treat attachments as just-another-
--                           pairing if we decide to unify.
--
-- The org_id column on core_files_files is denormalized — this tenant
-- DB IS one org — but it lets us tag rows with their owning tenant if
-- multi-tenant-per-DB or backups consolidate later.

create extension if not exists "pgcrypto";

create table core_files_files (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null,
  owner_user_id uuid,
  filename      text not null,
  mime_type     text not null,
  size_bytes    bigint not null,
  sha256        text not null,
  -- {original: {path, bytes}, medium: {path, bytes, width, height},
  --  thumb: {path, bytes, width, height}}. medium/thumb only for images.
  variants      jsonb not null,
  -- coarse kind ('image' / 'document' / 'video' / 'other') for filtering.
  kind          text not null,
  width         integer,
  height        integer,
  -- soft-delete: row stays around so attachments don't break links,
  -- but the file is hidden from list endpoints. A reaper can purge
  -- after a grace period.
  deleted_at    timestamptz,
  created_at    timestamptz not null default now()
);

create index core_files_files_sha256_idx on core_files_files(sha256);
create index core_files_files_created_idx on core_files_files(created_at desc);
create index core_files_files_kind_idx on core_files_files(kind) where deleted_at is null;

create table core_files_attachments (
  id              uuid primary key default gen_random_uuid(),
  file_id         uuid not null references core_files_files(id) on delete cascade,
  source_module   text not null,
  source_type     text not null,
  source_id       uuid not null,
  -- 'hero' / 'avatar' / 'gallery' / null. Lets one entity have multiple
  -- attached files with different semantic roles.
  role            text,
  sort_order      integer not null default 0,
  created_at      timestamptz not null default now(),
  -- One file per (entity, role). NULL roles count as distinct since pg
  -- unique treats NULLs as not-equal; for gallery-style multi-attach
  -- use role='gallery' and rely on sort_order instead.
  unique (file_id, source_module, source_type, source_id, role)
);

create index core_files_attachments_source_idx
  on core_files_attachments(source_module, source_type, source_id, sort_order);
create index core_files_attachments_file_idx on core_files_attachments(file_id);
