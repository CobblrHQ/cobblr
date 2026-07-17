-- Per-unit assignment (per-unit-assignment.md, option A). A generic holder for
-- an individual: "SN #3 is Janet's". Nullable + defaulted null, so it is purely
-- additive and existing installs heal on the next module-migration sync with no
-- data touched. Generic on purpose — any part can have a holder, not just a
-- serialized unit; a library relabels it "Borrower", an IT dept "Assigned to".
-- A free string now; per the design doc it upgrades to a member link later
-- without a data move (the string becomes the display, the link the reference).
alter table inventory_parts add column if not exists assigned_to text;
