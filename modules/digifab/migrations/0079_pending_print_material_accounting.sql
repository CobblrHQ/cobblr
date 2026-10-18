-- Pending print material accounting.
-- Additive: the prior reader keeps using material_drawn.
-- manual recovery if this fails partway: rerun; every statement is idempotent.
alter table digifab_jobs add column if not exists material_plan jsonb;
alter table digifab_jobs add column if not exists material_pending boolean not null default false;
create index if not exists digifab_material_pending on digifab_jobs (id) where material_pending;
