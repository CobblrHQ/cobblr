CREATE TABLE digifab_kiln_profiles (
 machine_id uuid PRIMARY KEY,
 connection_id uuid,
 device_id text,
 components jsonb NOT NULL DEFAULT '[]',
 schedules jsonb NOT NULL DEFAULT '[]',
 CHECK ((connection_id IS NULL) = (device_id IS NULL))
);
CREATE UNIQUE INDEX ON digifab_kiln_profiles (connection_id, device_id) WHERE connection_id IS NOT NULL;
CREATE TABLE digifab_firings (
 id uuid PRIMARY KEY,
 machine_id uuid NOT NULL,
 name text NOT NULL,
 recipe jsonb NOT NULL,
 status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'starting', 'running', 'completed', 'failed', 'stopped')),
 connection_id uuid,
 device_id text,
 peak_c double precision,
 duration_hours double precision,
 started_at timestamptz,
 ended_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK (duration_hours IS NULL OR duration_hours > 0)
);
CREATE INDEX ON digifab_firings (machine_id, created_at DESC);
CREATE UNIQUE INDEX ON digifab_firings (connection_id, device_id) WHERE status IN ('starting', 'running');
CREATE UNIQUE INDEX digifab_one_active_firing ON digifab_firings (machine_id) WHERE status IN ('starting', 'running');
