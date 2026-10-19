-- Robot arm program change control and backups (core spec #6883 §7): each
-- program revision keeps its text and whether a person released it for
-- production; a copy to another arm is a re-teach checklist; a backup is a
-- stored file with a retention and the result of its restore test.
--
-- Additive (lint:migration-additive): new nullable columns and columns with
-- defaults, and new tables.
--
-- manual recovery if this fails partway:
--   drop table if exists digifab_arm_backups;
--   drop table if exists digifab_arm_copies;
--   alter table digifab_arm_programs drop column if exists text_files, drop column if exists text_read_at, drop column if exists released_by, drop column if exists released_at;
--   alter table digifab_arm_units drop column if exists backup_keep, drop column if exists backup_every_hours, drop column if exists last_backup_at;

ALTER TABLE digifab_arm_programs ADD COLUMN IF NOT EXISTS text_files jsonb;
ALTER TABLE digifab_arm_programs ADD COLUMN IF NOT EXISTS text_read_at timestamptz;
ALTER TABLE digifab_arm_programs ADD COLUMN IF NOT EXISTS released_by uuid;
ALTER TABLE digifab_arm_programs ADD COLUMN IF NOT EXISTS released_at timestamptz;
ALTER TABLE digifab_arm_units ADD COLUMN IF NOT EXISTS backup_keep integer NOT NULL DEFAULT 10 CHECK (backup_keep BETWEEN 1 AND 100);
ALTER TABLE digifab_arm_units ADD COLUMN IF NOT EXISTS backup_every_hours integer CHECK (backup_every_hours IS NULL OR backup_every_hours BETWEEN 1 AND 720);
ALTER TABLE digifab_arm_units ADD COLUMN IF NOT EXISTS last_backup_at timestamptz;
CREATE TABLE digifab_arm_copies (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 source_program_id uuid NOT NULL REFERENCES digifab_arm_programs(id) ON DELETE CASCADE,
 target_machine_id uuid NOT NULL REFERENCES digifab_arm_units(machine_id) ON DELETE CASCADE,
 name text NOT NULL,
 uploaded boolean NOT NULL DEFAULT false,
 target_revision text,
 checklist jsonb NOT NULL,
 status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
 created_by uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 completed_by uuid,
 completed_at timestamptz
);
CREATE INDEX ON digifab_arm_copies (target_machine_id, name) WHERE status = 'open';
CREATE TABLE digifab_arm_backups (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 machine_id uuid NOT NULL REFERENCES digifab_arm_units(machine_id) ON DELETE CASCADE,
 taken_at timestamptz NOT NULL,
 file_id uuid NOT NULL,
 sha256 text NOT NULL,
 size_bytes integer NOT NULL,
 programs jsonb NOT NULL,
 installation_files integer NOT NULL DEFAULT 0,
 missing jsonb NOT NULL DEFAULT '[]',
 taken_by uuid,
 restore_tested_at timestamptz,
 restore_target_machine_id uuid,
 restore_ok boolean,
 restore_detail text
);
CREATE INDEX ON digifab_arm_backups (machine_id, taken_at DESC);
