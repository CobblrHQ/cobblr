CREATE TABLE IF NOT EXISTS builds_inspections (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 order_id uuid NOT NULL REFERENCES builds_planned(id),
 ordinal integer NOT NULL CHECK (ordinal > 0),
 revision integer NOT NULL DEFAULT 1,
 status text NOT NULL DEFAULT 'fail' CHECK (status IN ('pass', 'fail')),
 front_file_id uuid NOT NULL,
 back_file_id uuid NOT NULL,
 serial_code text,
 defects jsonb NOT NULL DEFAULT '[]',
 metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes text NOT NULL DEFAULT '',
 history jsonb NOT NULL DEFAULT '[]',
 inspected_by uuid,
 station_id uuid,
 inspected_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(order_id, ordinal)
);
CREATE UNIQUE INDEX IF NOT EXISTS builds_inspection_serial ON builds_inspections(serial_code) WHERE serial_code IS NOT NULL;
