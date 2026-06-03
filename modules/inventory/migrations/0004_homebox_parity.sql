-- HomeBox parity migration. Adds the missing home-inventory fields
-- so a Cobblr workspace can act as a HomeBox replacement:
--
--   asset_id          per-workspace auto-incrementing integer; the
--                     number printed on the physical sticker. Matches
--                     HomeBox's `#000-001`-style search shortcut.
--   serial_number     manufacturer's serial. Indexed for # search.
--   model_number      ditto.
--   warranty_expires  date the warranty ends. Renders as a pill on
--                     the part card when within 30 days.
--   lifetime_warranty boolean — when true, warranty_expires is hidden.
--   warranty_details  free-form notes ("ships with receipt; transferable").
--   insured           boolean — surfaces an insurance filter.
--   archived          boolean — soft-hide from default list views
--                     without deleting. Different from `state='draft'`
--                     (which means "incomplete record"); archived
--                     means "this thing left the active set".
--
-- The per-workspace asset_id sequence is a single bigserial-style
-- sequence; HomeBox's `000-001` format is purely a display concern
-- (we'll zero-pad to 3 digits in the UI). One sequence per tenant DB
-- means we never collide across workspaces — workspaces are
-- DB-isolated.
--
-- See docs/product/homebox-comparison.md for the full rationale.

create sequence if not exists inventory_parts_asset_id_seq start with 1;

alter table inventory_parts
  add column asset_id           bigint unique default nextval('inventory_parts_asset_id_seq'),
  add column serial_number      text,
  add column model_number       text,
  add column warranty_expires   date,
  add column lifetime_warranty  boolean not null default false,
  add column warranty_details   text,
  add column insured            boolean not null default false,
  add column archived           boolean not null default false;

-- Backfill asset_ids for any existing rows (the DEFAULT only fires
-- on new INSERTs).
update inventory_parts set asset_id = nextval('inventory_parts_asset_id_seq')
  where asset_id is null;

-- Searchable on serial/model — small tables benefit from btree;
-- ILIKE searches still scan but the indexes help exact-match.
create index if not exists inventory_parts_serial_idx
  on inventory_parts (lower(serial_number)) where serial_number is not null;
create index if not exists inventory_parts_model_idx
  on inventory_parts (lower(model_number)) where model_number is not null;
create index if not exists inventory_parts_warranty_idx
  on inventory_parts (warranty_expires) where warranty_expires is not null;
-- Hide archived rows from default list views — partial index keeps
-- the active set small even if the archive grows.
create index if not exists inventory_parts_active_idx
  on inventory_parts (created_at desc) where archived = false;
