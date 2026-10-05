create table digifab_material_dispatches (
 id uuid primary key default gen_random_uuid(),
 library_id uuid not null references digifab_library(id) on delete restrict,
 request jsonb not null default '{}'::jsonb,
 status text not null default 'queued',
 error text,
 shortage boolean not null default false,
 plan_ids jsonb not null default '[]'::jsonb,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create index digifab_material_dispatches_pending on digifab_material_dispatches(status, created_at);
