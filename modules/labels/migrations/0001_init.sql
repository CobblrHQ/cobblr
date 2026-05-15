-- Labels module — tenant-side schema for the print queue + history.
--
-- The queue holds pending labels (one per item the user wants to
-- print). Printing snapshots the queue into a batch + per-item
-- prints, then clears the queue. Templates table holds the
-- description-rendering rules per entity_kind.
--
-- Entities are polymorphic by (module_name, entity_type, entity_id)
-- — labels can be created for parts, locations, future projects, or
-- any other module's entity. No DB-level FKs across modules.

create extension if not exists "pgcrypto";

create table labels_templates (
  id                    uuid primary key default gen_random_uuid(),
  entity_kind           text not null unique,
  description_template  text not null,
  is_default            boolean not null default false,
  updated_at            timestamptz not null default now()
);

insert into labels_templates (entity_kind, description_template, is_default) values
  ('part',     '{{name}} · {{qty}} {{unit}}', true),
  ('location', '{{name}}',                     true);

create table labels_queue (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid,
  module_name     text not null,
  entity_type     text not null,
  entity_id       text not null,
  qr_payload      text not null,
  description     text not null,
  qty             integer not null default 1 check (qty > 0),
  created_at      timestamptz not null default now()
);

create index labels_queue_user_idx on labels_queue(user_id, created_at);
create index labels_queue_entity_idx on labels_queue(module_name, entity_type, entity_id);

create table labels_batches (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid,
  created_at   timestamptz not null default now(),
  printed_at   timestamptz
);

create table labels_prints (
  id              uuid primary key default gen_random_uuid(),
  batch_id        uuid not null references labels_batches(id) on delete cascade,
  module_name     text not null,
  entity_type     text not null,
  entity_id       text not null,
  qr_payload      text not null,
  description     text not null,
  qty             integer not null,
  printed_at      timestamptz not null default now()
);

create index labels_prints_batch_idx on labels_prints(batch_id);
create index labels_prints_entity_idx on labels_prints(module_name, entity_type, entity_id, printed_at desc);
