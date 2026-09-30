-- builds — a planned build made FOR something: a work order (#4052). A sales
-- order's line asks for N of a part, and the planned build that makes it
-- remembers the record it serves, so the order can read how many are made and
-- the schedule can say whom it is for. Weak reference, never a foreign key
-- (the source lives in another module). Additive.
alter table builds_planned add column if not exists source_kind text;
alter table builds_planned add column if not exists source_id text;
create index if not exists builds_planned_source_idx on builds_planned (source_kind, source_id);
