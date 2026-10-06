alter table digifab_jobs add column resin_print boolean not null default false;
create table digifab_resin_prints (
 job_id uuid primary key references digifab_jobs(id) on delete cascade,
 connection_id uuid not null,
 device_id text not null,
 review_file_id text not null,
 phase text not null default 'reviewed',
 snapshot jsonb not null default '{}'::jsonb,
 stock_error text,
 wash_done boolean not null default false,
 cure_done boolean not null default false,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create index digifab_resin_prints_pending on digifab_resin_prints(phase);
