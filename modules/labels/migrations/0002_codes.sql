-- Human-readable label codes: <prefix><number> per code group.
-- See docs/design-decisions/label-codes.md. Additive + nullable: existing
-- workspaces self-heal (codes backfill lazily the next time a label is made).
--
-- manual recovery if this fails partway:
--   DROP TABLE IF EXISTS labels_codes, labels_code_prefixes, labels_code_config;
--   DELETE FROM _prisma_migrations WHERE migration_name = '0002_codes';

-- Per-kind grain: which field's distinct values each own a prefix + number line.
-- Absent row => default 'instance' (which itself defaults to the module name,
-- so a single-instance kind is one line).
create table labels_code_config (
  entity_kind   text primary key,
  group_field   text not null default 'instance',
  updated_at    timestamptz not null default now()
);

-- One row per code group. Owns the group's prefix (globally unique in the
-- workspace; stored lowercase canonical so uniqueness is case-insensitive) and
-- its monotonic counter. frozen=true once the first code is minted — a printed
-- prefix can't change.
create table labels_code_prefixes (
  group_key   text primary key,
  entity_kind text not null,
  prefix      text not null unique,
  label       text,
  next_seq    integer not null default 1,
  frozen      boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- The frozen per-entity assignment. code = <prefix><seq>, lowercase canonical,
-- globally unique. One code per (kind, entity); numbers never reuse.
create table labels_codes (
  entity_kind text not null,
  entity_id   text not null,
  group_key   text not null,
  prefix      text not null,
  seq         integer not null,
  code        text not null unique,
  created_at  timestamptz not null default now(),
  primary key (entity_kind, entity_id)
);

create index labels_codes_group_idx on labels_codes(group_key);
