-- core-units: a workspace's unit vocabulary. The built-in canonical units
-- (gram/g, meter/m, each/ea, …) live in code (units-catalog.ts) — these
-- tables hold only the per-workspace EXTRAS and the display preference.
--
-- The `unit` field on parts (and anywhere else) stays free-text and is not
-- migrated; the catalog is a display + input aid that resolves a raw value
-- to a canonical entry. So nothing here rewrites existing data.

-- Custom units a workspace adds beyond the built-ins. `code` is the
-- canonical identity (lowercase-kebab); symbol is the shorthand.
create table core_units_custom (
  code        text primary key,
  symbol      text not null,
  name        text not null,
  plural      text not null,
  category    text not null default 'count',
  created_at  timestamptz not null default now()
);

-- Single-row settings table (the tenant DB is one-per-org, so one row).
-- display_mode drives shorthand-vs-full-word rendering everywhere.
create table core_units_settings (
  id            integer primary key default 1 check (id = 1),
  display_mode  text not null default 'symbol'
                  check (display_mode in ('symbol', 'name', 'both')),
  updated_at    timestamptz not null default now()
);
insert into core_units_settings (id) values (1) on conflict do nothing;
