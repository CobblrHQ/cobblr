CREATE TABLE IF NOT EXISTS digifab_bench_readings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 connection_id uuid NOT NULL,
 device_id text NOT NULL,
 machine_id uuid NOT NULL,
 record_kind text NOT NULL,
 record_id uuid NOT NULL,
 report jsonb NOT NULL,
 screenshot_file_id uuid,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS digifab_bench_readings_machine ON digifab_bench_readings(machine_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS digifab_bench_readings_record ON digifab_bench_readings(record_kind, record_id);
