-- Snapshot relay (opt-in, OFF by default). When on for a device, the edge agent
-- (OctoPrint plugin / edge-bridge) pushes a small JPEG every few seconds UP to
-- Cobblr, which serves the latest frame back — so a REMOTE viewer sees a
-- near-live thumbnail without the agent exposing the LAN camera or Cobblr
-- relaying full video. The latest frame is held in memory (ephemeral), not the
-- DB; this flag is just the per-device toggle. See architecture/edge-reach.md
-- → "What the tunnel carries".
alter table digifab_device_settings add column if not exists snapshot_relay boolean not null default false;
