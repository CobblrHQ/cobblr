-- A suggested picture is not a file until someone says Use it (#7447).
--
-- The record-photo suggestions stored each picture they found in Files
-- before anyone accepted it, and the backfill searched the web for every
-- existing record on upgrade, so an upgraded workspace's Files doubled with
-- pictures nobody asked for (a decline kept its file). A suggestion now
-- holds its picture's bytes here, in the suggestion store, and Use it is what
-- writes the file. Additive: every existing row holds none (its picture, if
-- any, is still the file_id it had; the heal moves an unaccepted one here).
alter table core_scan_record_photo_suggestions add column if not exists held_bytes bytea null;
alter table core_scan_record_photo_suggestions add column if not exists held_type text null;
alter table core_scan_record_photo_suggestions add column if not exists held_name text null;

-- Suggestions arrive OFF: an update never opts a workspace in, so no
-- workspace searches the web for its records until it turns this on.
alter table core_scan_photo_suggest_config add column if not exists suggest_on boolean not null default false;
