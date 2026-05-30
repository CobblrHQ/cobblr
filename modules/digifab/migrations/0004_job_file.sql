-- A job can reference a real stored file (core-files) whose bytes get
-- uploaded to the farm at send time — not just a routing string in
-- file_ref. No FK to core_files_files: digifab stays decoupled from
-- core-files' tables; the platform files-read seam resolves it at send
-- (and returns null harmlessly if the file is gone or core-files off).
alter table digifab_jobs add column file_id uuid;

-- Each migration runs in its own transaction (api/src/db/migrate.ts):
-- a failure rolls back fully and writes no `migrations` row, so a fixed
-- SQL just re-applies on the next enable/boot. Nothing to hand-undo.
