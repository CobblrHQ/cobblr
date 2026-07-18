-- Records — the neutral generic-record substrate. ONLY the universal
-- base: name, image, notes, location, custom-field bag. No state /
-- quantity / serial / warranty / manufacturer — catalog-like
-- collections (a Bookshelf, a Movies list) become instances of this
-- module and declare their own fields via field_defs, instead of
-- riding on assets and inheriting a drill-press's columns.

create table records_records (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  image_path  text,
  notes       text,
  location_id uuid,
  metadata    jsonb not null default '{}'::jsonb,
  -- Multi-instance scope — see docs/architecture/instances.md. Default
  -- matches the module name so legacy code paths land rows in the
  -- default 'records' instance; instance-aware writes set it.
  instance    text not null default 'records',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index records_records_instance_idx on records_records(instance);
