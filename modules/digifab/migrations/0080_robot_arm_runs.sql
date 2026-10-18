-- Robot arm runs: approvals, ownership, runs and the events the arm reported.
--
-- Additive (lint:migration-additive): new tables, and two new columns with defaults
-- on digifab_arm_units.
--
-- manual recovery if this fails partway:
--   drop table if exists digifab_arm_events;
--   drop table if exists digifab_arm_runs;
--   drop table if exists digifab_arm_ownership;
--   drop table if exists digifab_arm_approvals;
--   alter table digifab_arm_units drop column if exists tooling, drop column if exists event_cursor;

ALTER TABLE digifab_arm_units ADD COLUMN IF NOT EXISTS tooling text NOT NULL DEFAULT '';
ALTER TABLE digifab_arm_units ADD COLUMN IF NOT EXISTS event_cursor bigint NOT NULL DEFAULT 0;
CREATE TABLE digifab_arm_approvals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 machine_id uuid NOT NULL REFERENCES digifab_arm_units(machine_id) ON DELETE CASCADE,
 program_id uuid NOT NULL REFERENCES digifab_arm_programs(id) ON DELETE CASCADE,
 revision text,
 tooling text NOT NULL,
 station_id uuid NOT NULL,
 approved_by uuid NOT NULL,
 approved_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 used_at timestamptz,
 revoked_at timestamptz
);
CREATE INDEX ON digifab_arm_approvals (machine_id, approved_at DESC);
CREATE TABLE digifab_arm_ownership (
 machine_id uuid PRIMARY KEY REFERENCES digifab_arm_units(machine_id) ON DELETE CASCADE,
 station_id uuid NOT NULL,
 user_id uuid NOT NULL,
 acquired_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 released_at timestamptz,
 release_reason text
);
CREATE TABLE digifab_arm_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 machine_id uuid NOT NULL REFERENCES digifab_arm_units(machine_id) ON DELETE CASCADE,
 kind text NOT NULL CHECK (kind IN ('invocation', 'batch', 'order', 'shift', 'continuous')),
 label text NOT NULL DEFAULT '',
 ref text NOT NULL DEFAULT '',
 target_cycles integer CHECK (target_cycles IS NULL OR target_cycles > 0),
 program_id uuid REFERENCES digifab_arm_programs(id) ON DELETE SET NULL,
 approval_id uuid NOT NULL UNIQUE REFERENCES digifab_arm_approvals(id) ON DELETE RESTRICT,
 status text NOT NULL DEFAULT 'starting' CHECK (status IN ('starting', 'uncertain', 'running', 'ended')),
 outcome text CHECK (outcome IN ('completed', 'aborted', 'unknown', 'not-started')),
 controller_run_id text,
 cycles integer NOT NULL DEFAULT 0,
 good integer NOT NULL DEFAULT 0,
 scrap integer NOT NULL DEFAULT 0,
 link_lost text CHECK (link_lost IN ('cloud', 'controller')),
 evidence jsonb NOT NULL DEFAULT '{}',
 started_by uuid,
 started_at timestamptz NOT NULL DEFAULT now(),
 ended_at timestamptz,
 CHECK ((status = 'ended') = (outcome IS NOT NULL))
);
CREATE UNIQUE INDEX digifab_one_open_arm_run ON digifab_arm_runs (machine_id) WHERE status <> 'ended';
CREATE UNIQUE INDEX ON digifab_arm_runs (machine_id, controller_run_id) WHERE controller_run_id IS NOT NULL;
CREATE TABLE digifab_arm_events (
 machine_id uuid NOT NULL REFERENCES digifab_arm_units(machine_id) ON DELETE CASCADE,
 event_id text NOT NULL,
 seq bigint NOT NULL,
 type text NOT NULL,
 payload jsonb NOT NULL,
 run_id uuid REFERENCES digifab_arm_runs(id) ON DELETE SET NULL,
 received_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (machine_id, event_id)
);
CREATE INDEX ON digifab_arm_events (machine_id, seq DESC);
