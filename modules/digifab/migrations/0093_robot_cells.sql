-- Cells: machines that work together, run as one job at the edge (core spec
-- #6883 §4). A cell is a Machines record; its members are other machines on
-- the same bridge; a cell job is started at the cell's station and run by the
-- bridge, and each step it reports is recorded here.
--
-- Additive (lint:migration-additive): new tables only.
--
-- manual recovery if this fails partway:
--   drop table if exists digifab_cell_commands;
--   drop table if exists digifab_cell_events;
--   drop table if exists digifab_cell_steps;
--   drop table if exists digifab_cell_jobs;
--   drop table if exists digifab_cell_members;
--   drop table if exists digifab_cells;

CREATE TABLE digifab_cells (
 machine_id uuid PRIMARY KEY,
 connection_id uuid,
 device_id text,
 operators jsonb NOT NULL DEFAULT '[]',
 definition jsonb NOT NULL DEFAULT '{"label":"","steps":[],"cycles":1,"parts_per_cycle":1}',
 output_part_id uuid,
 event_cursor bigint NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((connection_id IS NULL) = (device_id IS NULL))
);
CREATE TABLE digifab_cell_members (
 cell_id uuid NOT NULL REFERENCES digifab_cells(machine_id) ON DELETE CASCADE,
 role text NOT NULL CHECK (role ~ '^[a-z][a-z0-9-]{0,39}$'),
 kind text NOT NULL CHECK (kind IN ('arm', 'machine', 'sensor')),
 machine_id uuid,
 connection_id uuid NOT NULL,
 device_id text NOT NULL,
 PRIMARY KEY (cell_id, role),
 CHECK ((kind = 'sensor') OR (machine_id IS NOT NULL))
);
CREATE INDEX ON digifab_cell_members (connection_id, device_id);
CREATE TABLE digifab_cell_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 cell_id uuid NOT NULL REFERENCES digifab_cells(machine_id) ON DELETE CASCADE,
 label text NOT NULL DEFAULT '',
 definition jsonb NOT NULL,
 definition_hash text NOT NULL,
 status text NOT NULL DEFAULT 'starting' CHECK (status IN ('starting', 'uncertain', 'running', 'paused', 'ended')),
 outcome text CHECK (outcome IN ('completed', 'aborted', 'unknown', 'not-started')),
 paused_on text CHECK (paused_on IN ('timeout', 'fault')),
 paused_reason text,
 cycles integer NOT NULL DEFAULT 0,
 parts integer NOT NULL DEFAULT 0,
 stock_cycles integer NOT NULL DEFAULT 0,
 last_cycle_ms integer,
 detail text NOT NULL DEFAULT '',
 station_id uuid,
 started_by uuid,
 started_at timestamptz NOT NULL DEFAULT now(),
 ended_at timestamptz,
 CHECK ((status = 'ended') = (outcome IS NOT NULL))
);
CREATE UNIQUE INDEX digifab_one_open_cell_job ON digifab_cell_jobs (cell_id) WHERE status <> 'ended';
CREATE INDEX ON digifab_cell_jobs (cell_id, started_at DESC);
CREATE TABLE digifab_cell_steps (
 job_id uuid NOT NULL REFERENCES digifab_cell_jobs(id) ON DELETE CASCADE,
 cycle integer NOT NULL CHECK (cycle > 0),
 step integer NOT NULL CHECK (step >= 0),
 kind text NOT NULL,
 role text NOT NULL,
 outcome text CHECK (outcome IN ('done', 'failed')),
 detail text,
 duration_ms integer,
 started_at timestamptz NOT NULL,
 ended_at timestamptz,
 PRIMARY KEY (job_id, cycle, step)
);
CREATE TABLE digifab_cell_events (
 cell_id uuid NOT NULL REFERENCES digifab_cells(machine_id) ON DELETE CASCADE,
 event_id text NOT NULL,
 seq bigint NOT NULL,
 type text NOT NULL,
 payload jsonb NOT NULL,
 job_id uuid REFERENCES digifab_cell_jobs(id) ON DELETE SET NULL,
 received_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (cell_id, event_id)
);
CREATE INDEX ON digifab_cell_events (cell_id, seq DESC);
CREATE TABLE digifab_cell_commands (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 cell_id uuid NOT NULL REFERENCES digifab_cells(machine_id) ON DELETE CASCADE,
 operation text NOT NULL CHECK (operation IN ('start', 'resume', 'stop')),
 job_id uuid,
 user_id uuid,
 via text NOT NULL CHECK (via IN ('page', 'station', 'assistant')),
 ok boolean NOT NULL,
 detail text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON digifab_cell_commands (cell_id, created_at DESC);
