-- The measured values a part holds, read off its title, description, notes and
-- custom fields ("Resistor 4k7", a value field holding "100nF"), so search,
-- sort and filter find them by VALUE without the record being changed.
--
--   measures      a jsonb array of { field, value, unit } (measureReadings in
--                 @cobblr/platform-contract/measure), written by the api
--   measures_key  what the readings are of: a hash of the text they were read
--                 from, kept by Postgres, so no write path has to remember it
--   measures_for  the key the stored readings were read at
--
-- A row whose measures_for differs from its measures_key has readings that are
-- missing or stale, and the api reads it again before it answers a search,
-- sort or filter by value (and the heal pass does every old row once). The
-- partial index makes "is anything stale" one index probe.
--
-- Additive + idempotent. The STORED generated column rewrites the table once,
-- as 0005's search_blob did.
--
-- manual recovery if this fails partway:
--   ALTER TABLE inventory_parts DROP COLUMN IF EXISTS measures_key;
--   ALTER TABLE inventory_parts DROP COLUMN IF EXISTS measures_for;
--   ALTER TABLE inventory_parts DROP COLUMN IF EXISTS measures;
--   DELETE FROM migrations WHERE name = '0013_measure_readings.sql';

-- Existing rows keep NULL (never read: what the heal pass looks for); a row
-- made from now on starts empty and stale, and is read on first use.
alter table inventory_parts add column if not exists measures jsonb;
alter table inventory_parts alter column measures set default '[]'::jsonb;
alter table inventory_parts add column if not exists measures_for text;

alter table inventory_parts
  add column if not exists measures_key text
  generated always as (
    md5(
      coalesce(name, '') || chr(31) ||
      coalesce(description, '') || chr(31) ||
      coalesce(notes, '') || chr(31) ||
      coalesce(metadata::text, '')
    )
  ) stored;

create index if not exists inventory_parts_measures_stale_idx
  on inventory_parts (instance)
  where measures_for is distinct from measures_key;
