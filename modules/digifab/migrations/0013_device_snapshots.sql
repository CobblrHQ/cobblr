-- Latest webcam frame per device for the snapshot relay — in the TENANT DB so it
-- works across multiple API instances (not just one process's memory). One row
-- per device, overwritten on each push (no unbounded growth); only written while
-- the relay is ON for that device (opt-in). Read with a freshness window; stale
-- rows read as absent.
create table if not exists digifab_device_snapshots (
  connection_id    uuid not null,
  remote_device_id text not null,
  jpeg             bytea not null,
  updated_at       timestamptz not null default now(),
  primary key (connection_id, remote_device_id)
);
