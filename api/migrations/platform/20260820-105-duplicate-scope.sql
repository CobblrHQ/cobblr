-- What "the same place" means for a kind, when deciding whether two of its
-- records are duplicates of each other.
--
-- "Delete duplicates" has to know this per kind and cannot guess it: two
-- locations called "Shelf 1" under the same rack are one shelf entered twice,
-- while the same two under different racks are two shelves. Two parts called
-- "M3 bolt" in one bin are a double entry; in two bins they are two piles.
-- Two assets called "Drill" are usually two drills.
--
-- So a kind declares the field that scopes it (or "workspace"), and a kind
-- that declares nothing is NOT deduplicated. Absent is the safe reading:
-- guessing that same-title means same-thing is the guess that deletes
-- somebody's work.
ALTER TABLE entity_kinds ADD COLUMN IF NOT EXISTS duplicate_scope text;

COMMENT ON COLUMN entity_kinds.duplicate_scope IS
  'Field name that scopes duplicate detection (e.g. parent_id, location_id), or "workspace". NULL = this kind is never deduplicated.';
