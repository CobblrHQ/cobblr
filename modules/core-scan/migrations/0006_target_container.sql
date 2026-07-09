-- Scan-into-container: the active "bin" for a scan session can be ANY container
-- (a server asset, a machine — not only a core-locations:location). When set,
-- confirm places the created entity INSIDE that container (a placement row via
-- platform().placement) instead of stamping a location_id. A Location is just
-- one KIND of container. Location filing (target_location_id) is unchanged.
alter table core_scan_inbox_items
  add column if not exists target_container_kind text,
  add column if not exists target_container_id   text;
