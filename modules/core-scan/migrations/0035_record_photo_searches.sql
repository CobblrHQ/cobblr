-- The last photo search for each record, as links (#4515).
--
-- Reopening a record's photo search after a reload fetched the web again and
-- forgot which result AI Pick had chosen. A search now leaves its result list
-- here: the phrase, and each result's picture address, thumbnail and page,
-- never a copy of the pictures nobody chose. The chosen one is remembered by
-- its address and the file it became, so the panel can outline the photo in
-- use and keep its AI mark. A few KB per record.
--
-- Additive: one new table. manual recovery if this fails partway: drop the
-- table; the panel then searches as it did before.

CREATE TABLE IF NOT EXISTS core_scan_record_photo_searches (
  entity_kind text NOT NULL,
  entity_id text NOT NULL,
  query text,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  ai_url text,
  ai_reason text,
  used_url text,
  used_file_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_kind, entity_id)
);
