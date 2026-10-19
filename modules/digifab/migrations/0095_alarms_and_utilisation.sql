-- Alarm history with escalation, and observed utilisation, for every machine
-- (core spec #6883 §7). An alarm is what a machine raised, in its own code
-- and words, with a camera frame when one is near; it is told to operators,
-- then supervisors, then integrators until someone acknowledges it.
-- Utilisation is the time each machine was seen running, idle, in fault or
-- not seen, by the hour, with how much of the hour was observed.
--
-- Additive (lint:migration-additive): new tables only.
--
-- manual recovery if this fails partway:
--   drop table if exists digifab_utilisation_last;
--   drop table if exists digifab_utilisation;
--   drop table if exists digifab_alarm_escalation;
--   drop table if exists digifab_alarms;

CREATE TABLE digifab_alarms (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 machine_id uuid NOT NULL,
 source text NOT NULL CHECK (source IN ('arm', 'machine')),
 source_ref text NOT NULL,
 code text NOT NULL,
 text text NOT NULL,
 severity text NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
 program text,
 step text,
 camera_file_id uuid,
 occurred_at timestamptz NOT NULL,
 escalation_level integer NOT NULL DEFAULT 0,
 next_escalation_at timestamptz,
 acknowledged_by uuid,
 acknowledged_at timestamptz,
 note text NOT NULL DEFAULT '',
 UNIQUE (machine_id, source_ref)
);
CREATE INDEX ON digifab_alarms (machine_id, occurred_at DESC);
CREATE INDEX ON digifab_alarms (next_escalation_at) WHERE acknowledged_at IS NULL AND next_escalation_at IS NOT NULL;
CREATE TABLE digifab_alarm_escalation (
 id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
 operators jsonb NOT NULL DEFAULT '[]',
 supervisors jsonb NOT NULL DEFAULT '[]',
 integrators jsonb NOT NULL DEFAULT '[]',
 supervisor_after_minutes integer NOT NULL DEFAULT 15 CHECK (supervisor_after_minutes BETWEEN 1 AND 1440),
 integrator_after_minutes integer NOT NULL DEFAULT 60 CHECK (integrator_after_minutes BETWEEN 1 AND 10080),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE digifab_utilisation (
 machine_id uuid NOT NULL,
 hour timestamptz NOT NULL,
 run_s integer NOT NULL DEFAULT 0,
 idle_s integer NOT NULL DEFAULT 0,
 fault_s integer NOT NULL DEFAULT 0,
 unknown_s integer NOT NULL DEFAULT 0,
 PRIMARY KEY (machine_id, hour)
);
CREATE TABLE digifab_utilisation_last (
 machine_id uuid PRIMARY KEY,
 state text NOT NULL CHECK (state IN ('run', 'idle', 'fault', 'unknown')),
 detail text NOT NULL DEFAULT '',
 seen_at timestamptz NOT NULL
);
