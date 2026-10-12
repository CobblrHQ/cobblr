-- A suggestion says what contradicts it (#5870): a VIN or serial on the item
-- that is not the record's (conflict: never a match), or a year that is not
-- (warning). Every record is matched once more, so a suggestion stored as
-- "matched by model" for another vehicle's paperwork is re-scored with the
-- rule on the next round, in every workspace, without anyone asking.

alter table core_documents_suggestions
  add column conflict text,
  add column warning text;

update core_documents_records set status = 'queued', attempts = 0;
