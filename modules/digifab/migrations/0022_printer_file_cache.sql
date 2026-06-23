-- Durable, backend-owned cache of each printer's on-disk gcode files + the
-- slicer thumbnail/estimate per file. The UI reads warm data from here; the
-- printer itself is touched only by the background warmer (poll-worker style),
-- never on a user's modal open. Thumbnails are immutable per (name,size,modified)
-- → fetched once and kept until the file changes.
create table if not exists digifab_printer_files (
  connection_id   text not null,
  device_id       text not null,
  name            text not null,
  size            int,
  modified        text,                 -- raw rr_filelist date (printer-local, no TZ)
  print_time_sec  int,
  filament_mm     double precision,
  num_layers      int,
  height          double precision,
  generated_by    text,
  thumbnail       text,                 -- data URI; null = none / not yet fetched
  info_fetched_at timestamptz,          -- null = estimate + thumbnail still pending
  list_seen_at    timestamptz not null default now(),
  primary key (connection_id, device_id, name)
);

-- One row per device: when the list was last pulled + the warm-loop heartbeat.
create table if not exists digifab_printer_file_meta (
  connection_id   text not null,
  device_id       text not null,
  list_fetched_at timestamptz,
  warm_at         timestamptz,
  primary key (connection_id, device_id)
);
