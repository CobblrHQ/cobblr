-- Inventory module — initial tenant-side schema.
-- Runs once per tenant DB when the inventory module is enabled for
-- the org. Tables are prefixed `inventory_` per the module manifest's
-- tablePrefix so they coexist cleanly with future modules in the
-- same tenant DB.

create extension if not exists "pgcrypto";

-- ─────────────────────── inventory_categories ─────────────────────
--
-- User-definable per tenant. We seed three generic defaults so a
-- fresh inventory has somewhere to put a first part; users can
-- rename / add / delete freely.

create table inventory_categories (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text not null unique,
  color       text,
  parent_id   uuid references inventory_categories(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index inventory_categories_parent_idx on inventory_categories(parent_id);

-- ─────────────────────── inventory_locations ──────────────────────
--
-- Hierarchical tree of places parts can live. kind is intentionally
-- coarse — 'container' (a thing parts go into: bin, drawer, shelf)
-- vs 'area' (a broader region: room, corner, workshop). Users use
-- short_name when the rendered label needs to differ from the
-- canonical name ("Bin 17" vs "Top-shelf 7th from the left").

create table inventory_locations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  short_name  text,
  parent_id   uuid references inventory_locations(id) on delete cascade,
  depth       integer not null default 0,
  kind        text not null default 'area'
                check (kind in ('container', 'area')),
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index inventory_locations_parent_idx on inventory_locations(parent_id);

-- ───────────────────────── inventory_parts ────────────────────────
--
-- The inventory entity itself. State enum covers the photo-ID flow
-- that ships later (Phase 5+); for Phase 1 every part is `active`
-- and the other two states are unused. The schema's ready when the
-- pipeline arrives — no migration needed at that point.
--
-- `metadata` jsonb is the agreed Phase-1 custom-fields surface.
-- Free-form per tenant. Typed field definitions are a later feature.

create table inventory_parts (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  description     text,
  category_id     uuid references inventory_categories(id) on delete set null,
  location_id     uuid references inventory_locations(id) on delete set null,
  qty             numeric(12,3) not null default 0,
  unit            text not null default 'each',
  cost            numeric(12,2),
  min_qty         numeric(12,3),
  manufacturer    text,
  supplier_url    text,
  image_path      text,
  notes           text,
  state           text not null default 'active'
                    check (state in ('active', 'draft', 'needs_review')),
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index inventory_parts_category_idx on inventory_parts(category_id);
create index inventory_parts_location_idx on inventory_parts(location_id);
create index inventory_parts_state_idx on inventory_parts(state);
create index inventory_parts_low_stock_idx
  on inventory_parts(state)
  where min_qty is not null;

-- ────────────────────── inventory_allocations ─────────────────────
--
-- Polymorphic by design: target_module + target_entity_type +
-- target_entity_id is a soft reference that points at whatever
-- (module, kind-of-thing, id) the allocation is for. NO database
-- FK to the target — it lives in another module's tables, possibly
-- in a separate DB someday. If the target disappears we leave the
-- allocation dangling and surface "(unknown)" in the UI.
--
-- Cross-module knock-on flows through the event bus (inventory
-- emits stock.changed, other modules subscribe). No direct call into
-- another module's recomputation.

create table inventory_allocations (
  id                  uuid primary key default gen_random_uuid(),
  part_id             uuid not null references inventory_parts(id) on delete cascade,
  qty                 numeric(12,3) not null check (qty > 0),
  status              text not null default 'reserved'
                        check (status in ('reserved', 'consumed', 'released')),
  target_module       text not null,
  target_entity_type  text not null,
  target_entity_id    text not null,
  reason              text,
  reserved_at         timestamptz not null default now(),
  consumed_at         timestamptz,
  released_at         timestamptz
);

create index inventory_allocations_part_idx on inventory_allocations(part_id);
create index inventory_allocations_target_idx
  on inventory_allocations(target_module, target_entity_type, target_entity_id);
create index inventory_allocations_status_idx on inventory_allocations(status);

-- ─────────────────────────── seed data ────────────────────────────
--
-- Three generic categories so a fresh tenant has somewhere to drop
-- a first part. Users rename / delete / add freely.

insert into inventory_categories (name, slug) values
  ('Tools', 'tools'),
  ('Materials', 'materials'),
  ('Components', 'components');
