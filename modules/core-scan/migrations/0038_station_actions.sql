-- A known thing's own record actions on a Station (#4640): Log service, Lend,
-- Mark service done. Each run by the tablet's request id, so a retry is
-- answered from here instead of running twice, and with the way back the
-- action itself handed over, so the tablet's Undo runs exactly that and a
-- kiosk token never sends steps of its own.
create table if not exists core_scan_station_actions (
  address    text not null,
  request_id text not null,
  action_id  text not null,
  kind       text not null,
  entity_id  text not null,
  label      text not null,
  ok         boolean,
  undo       jsonb,
  undone_at  timestamptz,
  created_at timestamptz not null default now(),
  primary key (address, request_id)
);
