-- Guided software updates for robot arms (core spec #6883 §2): the update
-- file kept in Files with its checksum, the vendor's steps ticked by the
-- person at the arm, and the version the controller reports afterwards.
--
-- Additive (lint:migration-additive): a new table only.
--
-- manual recovery if this fails partway:
--   drop table if exists digifab_arm_updates;

CREATE TABLE digifab_arm_updates (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 machine_id uuid NOT NULL REFERENCES digifab_arm_units(machine_id) ON DELETE CASCADE,
 vendor text NOT NULL,
 file_id uuid,
 file_sha256 text,
 target_version text NOT NULL,
 from_versions jsonb NOT NULL DEFAULT '[]',
 steps jsonb NOT NULL,
 status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'verified', 'failed', 'cancelled')),
 read_back jsonb,
 detail text NOT NULL DEFAULT '',
 created_by uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 ended_by uuid,
 ended_at timestamptz
);
CREATE UNIQUE INDEX digifab_one_open_arm_update ON digifab_arm_updates (machine_id) WHERE status = 'open';
