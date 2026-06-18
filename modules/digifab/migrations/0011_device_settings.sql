-- Per-device cockpit settings — a manual override store keyed by
-- (connection_id, remote_device_id), like the attention table. First use: a
-- camera/webcam stream URL a user sets for a printer whose manager doesn't
-- expose one discoverably (FluidNC, a bare LightBurn, etc.). The fleet merges
-- this over any driver-reported camera. Coordinate-not-control holds — Cobblr
-- only embeds the URL; it never proxies the video.
create table if not exists digifab_device_settings (
  connection_id    uuid not null,
  remote_device_id text not null,
  camera_url       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (connection_id, remote_device_id)
);
