-- core-templates — per-workspace entity templates. The "stamp out
-- household appliances from this template" flow from
-- docs/homebox-comparison.md Tier 2.
--
-- A template is a typed payload of default values targeting a
-- specific entity kind. When a user "creates from template", the
-- payload is POSTed to that kind's create endpoint, optionally
-- merged with the caller's overrides. The caller still owns the
-- final entity — the template just primes the form.
--
-- Tags applied via `default_tags` get attached after the entity is
-- created, via core-tags' polymorphic attachments table.

create table core_templates_templates (
  id            uuid primary key default gen_random_uuid(),
  -- "inventory:part" / "assets:asset" / "machines:machine" / etc.
  target_kind   text not null,
  name          text not null,
  description   text,
  -- The default field values to pre-fill on a new entity. Free-form
  -- jsonb so this works for any kind's shape — the create endpoint
  -- validates it as usual.
  defaults      jsonb not null default '{}'::jsonb,
  -- Tag names to attach after creation. Created on the fly if they
  -- don't exist (core-tags is already lenient about that).
  default_tags  jsonb not null default '[]'::jsonb,
  -- Sort hint in pickers. Lower first.
  position      integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index core_templates_kind_idx
  on core_templates_templates (target_kind, position);
