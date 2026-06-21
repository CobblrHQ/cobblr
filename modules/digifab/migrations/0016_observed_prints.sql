-- Observed prints — finished prints Cobblr DIDN'T start (so there's no
-- digifab_jobs row), but watched complete via live telemetry. Today that's the
-- Bambu cloud-MQTT pump: cloud Bambu is monitor-only, so every Bambu print is
-- started from Bambu Studio and would otherwise be invisible to history. The pump
-- records one row when a print transitions printing → completed/failed. The
-- history view merges these with digifab_jobs.
--
-- manual recovery if this fails partway:
--   DROP TABLE IF EXISTS digifab_observed_prints;
--   DELETE FROM _prisma_migrations WHERE migration_name = '0016_observed_prints';
create table if not exists digifab_observed_prints (
  id            uuid primary key default gen_random_uuid(),
  connection_id text not null,
  serial        text not null,
  file_ref      text,
  status        text not null,      -- 'completed' | 'failed'
  started_at    timestamptz,
  ended_at      timestamptz not null default now(),
  created_at    timestamptz not null default now()
);
create index if not exists digifab_observed_prints_ended on digifab_observed_prints (ended_at);
