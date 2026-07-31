-- One row per scan IMPORT, holding everything needed to reverse it.
--
-- A bulk import is the one scan operation a person cannot undo by hand: it can
-- touch hundreds of rows at once, and with duplicate_policy=replace it also
-- OVERWRITES rows that were already there. Without a recorded before-state,
-- "that import was wrong" has no answer except restoring a backup.
--
-- `undo` holds: the ids this run created, the prior contents of every row it
-- replaced, and the sessions it created - enough to put the inbox back exactly
-- as it was, in one call.

create table if not exists core_scan_import_runs (
  id                 uuid primary key default gen_random_uuid(),
  created_at         timestamptz not null default now(),
  created_by_user_id uuid,
  -- Where the items came from, so a listing can say "from cobblr.me, 69 items".
  source_instance    text,
  source_label       text,
  item_count         integer not null default 0,
  created_count      integer not null default 0,
  replaced_count     integer not null default 0,
  -- { created_item_ids: [], created_batch_ids: [], replaced: [{ id, before: {...} }] }
  undo               jsonb   not null default '{}'::jsonb,
  -- Set when the run has been reversed; a run is undoable exactly once.
  undone_at          timestamptz
);

create index if not exists core_scan_import_runs_created_idx
  on core_scan_import_runs (created_at desc);
