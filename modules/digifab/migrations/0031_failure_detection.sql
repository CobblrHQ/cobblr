-- AI print-failure detection: a per-workspace config (singleton) + per-device
-- EWM watch state. The watcher samples a printing device's camera, accumulates
-- an exponentially-weighted failure score, and (optionally) auto-pauses + flags
-- the print when the score crosses a threshold. DB-backed so it survives process
-- restarts and works across multiple API instances (like the file-warmer).
--
-- manual recovery if this fails partway:
--   DROP TABLE IF EXISTS digifab_failure_watch;
--   DROP TABLE IF EXISTS digifab_failure_config;
--   DELETE FROM _prisma_migrations WHERE migration_name = '0031_failure_detection';

CREATE TABLE IF NOT EXISTS digifab_failure_config (
  id boolean PRIMARY KEY DEFAULT true,
  enabled boolean NOT NULL DEFAULT false,
  -- score in [0,1] that trips auto-pause / the alert.
  threshold real NOT NULL DEFAULT 0.6,
  sample_interval_sec integer NOT NULL DEFAULT 30,
  auto_pause boolean NOT NULL DEFAULT true,
  -- auto = the local edge model when the machine's bridge offers it, else the
  -- workspace's vision AI; edge = local model only; llm = vision AI only.
  backend text NOT NULL DEFAULT 'auto',
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT digifab_failure_config_singleton CHECK (id)
);

CREATE TABLE IF NOT EXISTS digifab_failure_watch (
  connection_id text NOT NULL,
  device_id text NOT NULL,
  -- the print being watched (the job id); score resets when this changes.
  job_key text,
  score real NOT NULL DEFAULT 0,
  samples integer NOT NULL DEFAULT 0,
  last_probability real,
  last_source text,               -- 'edge' | 'llm'
  paused_at timestamptz,          -- non-null once auto-pause fired for this print
  watch_at timestamptz,           -- loop heartbeat (a fresher one → a loop is alive)
  last_sample_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, device_id)
);
