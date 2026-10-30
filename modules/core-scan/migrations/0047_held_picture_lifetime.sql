-- A held suggestion picture has a lifetime (#8941). Since 0046 a suggestion
-- kept its picture's whole download here until someone answered it, and one
-- nobody answered kept it for good: 2.19 GB in staging's nightly dumps, which
-- filled the disk holding them.
--
-- LIFETIME: held_bytes is a preview (services/held-picture.ts), dropped on
-- Use it, No thanks, Search again, a record that got its own picture, and
-- HELD_DAYS after held_at (the record-photo sweep). The row keeps
-- source_url, so the picture is fetched again when someone looks at it.
--
-- Additive (lint:migration-additive): a nullable column and an index. An
-- existing row's held_at is null, and the sweep reads it as held when the
-- row was last updated.
--
-- manual recovery if this fails partway:
--   drop index if exists core_scan_record_photo_suggestions_held;
--   alter table core_scan_record_photo_suggestions drop column if exists held_at;
alter table core_scan_record_photo_suggestions add column if not exists held_at timestamptz null;

create index if not exists core_scan_record_photo_suggestions_held
  on core_scan_record_photo_suggestions (coalesce(held_at, updated_at))
  where held_bytes is not null;
