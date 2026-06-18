-- Consumption tracking. A consumable part (a filament spool, a yarn cone, a roll
-- of tape — anything you draw down) keeps `qty` as what's REMAINING; its full /
-- new amount ("1kg spool") rides in metadata.capacity (a domain-flavored field,
-- not native, per module conventions). This adds the LEDGER: every wire-driven
-- stock change lands here so you can see WHAT drew it down and HOW MUCH. Generic
-- by design — not filament-specific.

create table inventory_consumption (
  id          uuid primary key default gen_random_uuid(),
  part_id     uuid not null references inventory_parts(id) on delete cascade,
  delta       numeric not null,            -- signed: negative = consumed, positive = restocked
  reason      text,                        -- human label ("Print: bracket.gcode")
  source_kind text,                        -- optional attribution, e.g. "digifab:job"
  source_id   text,
  at          timestamptz not null default now()
);
create index inventory_consumption_part_idx on inventory_consumption(part_id, at desc);

-- manual recovery if this fails partway:
--   DROP TABLE inventory_consumption;
--   ALTER TABLE inventory_parts DROP COLUMN capacity;
