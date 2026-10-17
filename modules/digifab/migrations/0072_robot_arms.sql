-- Robot arms: units, their programs and every command sent.
--
-- Additive (lint:migration-additive): three new tables, nothing existing changes.
--
-- manual recovery if this fails partway:
--   drop table if exists digifab_arm_commands;
--   drop table if exists digifab_arm_programs;
--   drop table if exists digifab_arm_units;

CREATE TABLE digifab_arm_units (
 machine_id uuid PRIMARY KEY,
 connection_id uuid,
 device_id text,
 maintenance text NOT NULL DEFAULT 'in-service' CHECK (maintenance IN ('in-service', 'down-for-repair')),
 maintenance_note text NOT NULL DEFAULT '',
 compatibility jsonb NOT NULL DEFAULT '{}',
 last_info jsonb,
 info_seen_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((connection_id IS NULL) = (device_id IS NULL))
);
CREATE UNIQUE INDEX ON digifab_arm_units (connection_id, device_id) WHERE connection_id IS NOT NULL;
CREATE TABLE digifab_arm_programs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 machine_id uuid NOT NULL REFERENCES digifab_arm_units(machine_id) ON DELETE CASCADE,
 name text NOT NULL,
 revision text,
 family text,
 tool text NOT NULL DEFAULT '',
 installation text NOT NULL DEFAULT '',
 source text NOT NULL CHECK (source IN ('controller', 'typed')),
 first_seen_at timestamptz NOT NULL DEFAULT now(),
 last_seen_at timestamptz NOT NULL DEFAULT now(),
 missing_since timestamptz
);
CREATE UNIQUE INDEX digifab_arm_programs_revision ON digifab_arm_programs (machine_id, name, coalesce(revision, ''));
CREATE INDEX ON digifab_arm_programs (family) WHERE family IS NOT NULL;
CREATE TABLE digifab_arm_commands (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 machine_id uuid NOT NULL REFERENCES digifab_arm_units(machine_id) ON DELETE CASCADE,
 operation text NOT NULL CHECK (operation IN ('load', 'start', 'pause', 'resume', 'stop', 'power')),
 program_id uuid REFERENCES digifab_arm_programs(id) ON DELETE SET NULL,
 params jsonb NOT NULL DEFAULT '{}',
 user_id uuid,
 via text NOT NULL CHECK (via IN ('page', 'station', 'assistant')),
 ok boolean NOT NULL,
 detail text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON digifab_arm_commands (machine_id, created_at DESC);
