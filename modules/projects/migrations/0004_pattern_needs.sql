-- What a pattern needs: each yarn and each hook or needle it calls for, one
-- row per requirement, kept on the pattern.
--
-- Before this the reading of a pattern PDF lived only in the browser and was
-- gone when the window closed; nothing could match it against the stash, put
-- a missing yarn on a shopping list, or say how much a finished pattern used.
-- A pattern with two yarns has two rows, each with its own length, so each can
-- later be bound to its own balls.
--
-- `source` is where the row came from: the pattern's own text, the AI (only
-- when the text named nothing this could read), or the person. `edited` marks
-- a row somebody changed by hand, which a re-read of the pattern never
-- replaces. `length_choices` holds the per-ball lengths a pattern gives by
-- kind of colour ("solid" 333 m, "print" 215 m) when it does not say which
-- one this yarn is; `length_m` stays empty until someone picks. A yarn row's
-- id is the `target_line` of every inventory reservation made for it, which is
-- how each of a pattern's yarns keeps its own balls.

create table projects_pattern_needs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects_projects(id) on delete cascade,
  kind text not null check (kind in ('yarn', 'hook', 'needle')),
  position integer not null default 0,
  label text,
  brand text,
  product text,
  color text,
  color_code text,
  weight text,
  fiber text,
  quantity numeric(12, 3),
  quantity_unit text,
  unit_length_m numeric(12, 2),
  length_m numeric(12, 2),
  length_choices jsonb,
  size_mm numeric(6, 2),
  size_label text,
  source text not null default 'pattern' check (source in ('pattern', 'ai', 'hand')),
  pattern_file_id uuid,
  edited boolean not null default false,
  -- The stash record picked to make it with (an inventory part, by id; the
  -- balls themselves are inventory's reservations on this row's line).
  part_id uuid,
  -- The shopping-list line added for what is missing, kept so a change of
  -- yarn can take it back off or change it.
  list_item_id uuid,
  -- When a finished pattern took this yarn off the stash, and what it said.
  settled_at timestamptz,
  settle_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index projects_pattern_needs_project on projects_pattern_needs (project_id, position);

-- One row per (pattern, file) read: whether it is done, how it was read, and
-- why nothing came back when nothing did. `ai_tried` lets a pattern imported
-- in a batch (read from its text only) ask the AI once, the first time
-- somebody opens it, rather than a hundred AI calls for one zip.
create table projects_pattern_reads (
  project_id uuid not null references projects_projects(id) on delete cascade,
  pattern_file_id uuid not null,
  status text not null check (status in ('ready', 'empty', 'failed')),
  method text check (method in ('pattern', 'ai')),
  ai_tried boolean not null default false,
  reason text,
  read_at timestamptz not null default now(),
  primary key (project_id, pattern_file_id)
);
