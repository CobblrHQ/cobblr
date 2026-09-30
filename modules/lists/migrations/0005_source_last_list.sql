-- The list a record last went on, so "Add to list" on a part running low
-- goes back there without asking again. A line forgets its record when the
-- ticked lines are cleared, so the list cannot be read back off the lines.
-- Additive.

create table if not exists lists_source_last_list (
  source_kind text not null,
  source_id text not null,
  list_id uuid not null references lists_lists(id) on delete cascade,
  updated_at timestamptz not null default now(),
  primary key (source_kind, source_id)
);
