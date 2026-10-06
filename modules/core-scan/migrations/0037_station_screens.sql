-- A Station (#4640): a tablet that a barcode scanner drives, at an address of
-- its own (/station/<workspace>/<address>). Its settings live here; the
-- tablet's token lives with the platform's tokens.
create table if not exists core_scan_station_screens (
  address    text primary key,
  label      text not null,
  settings   jsonb not null default '{}'::jsonb,
  -- The owner PIN that lets the tablet itself change these settings: a hash,
  -- never the PIN. Null: only a signed-in owner or admin can.
  pin_hash   text,
  updated_at timestamptz not null default now()
);

-- Every stock move a station makes, by the tablet's own request id: a retry
-- after a dropped connection (the tablet queues while offline) is answered
-- from here instead of counting twice, and Undo reverses exactly what moved.
create table if not exists core_scan_station_moves (
  address    text not null,
  request_id text not null,
  kind       text not null,
  entity_id  text not null,
  instance   text,
  op         text not null,
  delta      numeric not null,
  qty        numeric,
  note       text,
  undone_at  timestamptz,
  created_at timestamptz not null default now(),
  primary key (address, request_id)
);

-- Codes a bridge read for a station that has no keyboard scanner of its own:
-- the bridge posts them, the station's screen takes them in order.
create table if not exists core_scan_station_scans (
  id         bigserial primary key,
  address    text not null,
  code       text not null,
  created_at timestamptz not null default now(),
  taken_at   timestamptz
);
create index if not exists core_scan_station_scans_waiting on core_scan_station_scans (address, id) where taken_at is null;
