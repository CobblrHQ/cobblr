-- Live cloud-MQTT telemetry per Bambu printer. The bambu-pump holds an MQTT
-- subscription to Bambu's cloud broker per account and writes the latest report
-- here; the fleet reads it (fresh) to show real-time temps/progress/state instead
-- of the slower HTTP status. TENANT DB so it survives restarts + works across API
-- instances. One row per (connection, serial), overwritten on each report. Read
-- with a freshness window; a stale row reads as absent (→ HTTP fallback).
--
-- manual recovery if this fails partway:
--   DROP TABLE IF EXISTS digifab_bambu_status;
--   DELETE FROM _prisma_migrations WHERE migration_name = '0014_bambu_status';
create table if not exists digifab_bambu_status (
  connection_id  text not null,
  serial         text not null,
  state          text,
  stage          text,
  nozzle_actual  double precision,
  nozzle_target  double precision,
  bed_actual     double precision,
  bed_target     double precision,
  chamber_actual double precision,
  chamber_target double precision,
  progress       integer,
  remaining_min  integer,
  layer_num      integer,
  total_layers   integer,
  updated_at     timestamptz not null default now(),
  primary key (connection_id, serial)
);
