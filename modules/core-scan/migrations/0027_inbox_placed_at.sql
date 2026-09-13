-- The one honest state per scanned item, through the whole put-away flow:
-- assigned (target_location_id), filed (status resolved, target_entity_id),
-- placed (this). Placement used to live only on the put-away session that
-- happened to be walking one plan, so a second plan could not see it and an
-- ended walk read as never started (#2897). The item carries it now, and
-- every plan, walk and resume chip reads the same column.
alter table core_scan_inbox_items
  add column if not exists placed_at timestamptz;
