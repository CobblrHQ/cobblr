-- A job and a Make keep the fields a bundle or a person adds to them (on
-- /fields), like every other record with a sheet. Additive: two jsonb
-- columns defaulting to an empty object.

alter table digifab_jobs add column if not exists metadata jsonb not null default '{}'::jsonb;
alter table digifab_makes add column if not exists metadata jsonb not null default '{}'::jsonb;
