-- What a sync does when the source and Cobblr disagree about a field (#6336).
--
-- The owner mirrors an outside system into Cobblr and treats Cobblr as the
-- source of truth; a sync used to write the source's value over an edit made
-- in Cobblr. Each section now has a rule the person can see and set:
--   'cobblr' (the default)  Cobblr's edit is kept; the source's other fields still come across
--   'source'                the source's value is written over the edit
--   'ask'                   Cobblr's edit is kept and the disagreement is listed until settled
--
--   conflict_policy   per (connection, section), on the existing sync state row.
--   last_conflicts    what the last run asked about: { conflicts: [...], ambiguous: [...] }.
--   synced_fields     on the id-map: what the source last said for each field the
--                     sync manages, so "changed in Cobblr since the last sync" is
--                     a comparison and not a guess (a three-way merge's base).
--                     Null until a record's first run after this lands; with no base
--                     a differing, filled-in Cobblr value is read as the person's.
--
-- Additive, nullable or defaulted: existing connections keep running, now under
-- Cobblr wins.

alter table core_integrations_sync_state
  add column conflict_policy text not null default 'cobblr',
  add column last_conflicts jsonb not null default '{"conflicts":[],"ambiguous":[]}'::jsonb;

alter table core_integrations_synced_records
  add column synced_fields jsonb;
