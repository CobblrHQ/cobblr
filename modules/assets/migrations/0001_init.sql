-- Assets — "physical things I own that DON'T act on their own."
-- Appliances, hand tools, computer cases, vinyl records, anything
-- with a serial number or a warranty or just a need to be tracked.
-- Sibling to inventory:part (which is for fungible stock) and
-- machines:machine (which is for things that do something on their
-- own).

create table assets_assets (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  short_name      text,
  manufacturer    text,
  model           text,
  type            text,
  state           text not null default 'working',
  excitement      int default 0,
  quantity        int default 1,
  serial_number   text,
  purchased_at    date,
  warranty_until  date,
  last_service_at date,
  image_path      text,
  notes           text,
  location_id     uuid,
  flags           jsonb not null default '[]'::jsonb,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index assets_assets_state_idx on assets_assets(state);
