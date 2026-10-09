CREATE TABLE IF NOT EXISTS digifab_test_plans (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), latest_version integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS digifab_test_plan_versions (
 plan_id uuid NOT NULL REFERENCES digifab_test_plans(id), version integer NOT NULL,
 name text NOT NULL, plan jsonb NOT NULL, plan_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (plan_id, version)
);
CREATE TABLE IF NOT EXISTS digifab_test_units (
 unit_kind text NOT NULL, unit_id uuid NOT NULL, product_kind text NOT NULL, product_id uuid NOT NULL,
 serial text NOT NULL, details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (unit_kind, unit_id), UNIQUE (product_kind, product_id, serial)
);
CREATE TABLE IF NOT EXISTS digifab_test_jigs (
 asset_id uuid PRIMARY KEY, name text NOT NULL, plans jsonb NOT NULL DEFAULT '[]',
 pin_map text NOT NULL DEFAULT '', cycle_count integer NOT NULL DEFAULT 0,
 maintenance_every integer NOT NULL DEFAULT 1000 CHECK (maintenance_every > 0),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS digifab_test_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), unit_kind text NOT NULL, unit_id uuid NOT NULL,
 plan_id uuid NOT NULL, plan_version integer NOT NULL, plan jsonb NOT NULL, plan_hash text NOT NULL,
 attempt integer NOT NULL, operator_id uuid NOT NULL, station text NOT NULL, jig_id uuid, bridge_connection_id uuid,
 jig_cycle integer, unit_snapshot jsonb NOT NULL DEFAULT '{}', metadata jsonb NOT NULL DEFAULT '{}', result jsonb, prepared_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 FOREIGN KEY (plan_id, plan_version) REFERENCES digifab_test_plan_versions(plan_id, version),
 UNIQUE (unit_kind, unit_id, attempt)
);
CREATE INDEX IF NOT EXISTS digifab_test_runs_unit ON digifab_test_runs (unit_kind, unit_id, attempt DESC);
CREATE TABLE IF NOT EXISTS digifab_test_dispositions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid NOT NULL REFERENCES digifab_test_runs(id),
 status text NOT NULL CHECK (status IN ('reworked', 'scrapped')), operator_id uuid NOT NULL,
 notes text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION digifab_test_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 -- Custom fields annotate an attempt; they are not its evidence, so they alone may change.
 IF TG_TABLE_NAME = 'digifab_test_runs' AND TG_OP = 'UPDATE' AND (to_jsonb(NEW) - 'metadata') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'metadata') THEN
  RETURN NEW;
 END IF;
 IF TG_TABLE_NAME <> 'digifab_test_runs' THEN
  RAISE EXCEPTION 'Finished production evidence is immutable';
 END IF;
 IF OLD.finished_at IS NOT NULL THEN
  RAISE EXCEPTION 'Finished production evidence is immutable';
 END IF;
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
 IF (to_jsonb(NEW) - 'result' - 'finished_at') IS DISTINCT FROM (to_jsonb(OLD) - 'result' - 'finished_at') THEN
  RAISE EXCEPTION 'Prepared production evidence is immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER digifab_test_version_immutable BEFORE UPDATE OR DELETE ON digifab_test_plan_versions FOR EACH ROW EXECUTE FUNCTION digifab_test_immutable();
CREATE TRIGGER digifab_test_run_immutable BEFORE UPDATE OR DELETE ON digifab_test_runs FOR EACH ROW EXECUTE FUNCTION digifab_test_immutable();
CREATE TRIGGER digifab_test_disposition_immutable BEFORE UPDATE OR DELETE ON digifab_test_dispositions FOR EACH ROW EXECUTE FUNCTION digifab_test_immutable();
CREATE TABLE IF NOT EXISTS digifab_test_numbering (
 product_kind text NOT NULL, product_id uuid NOT NULL, next_number integer NOT NULL DEFAULT 1,
 pattern text NOT NULL DEFAULT '{CUST}-{PROD}-{YYWW}-{#####}',
 customer_code text NOT NULL DEFAULT 'CUST', product_code text NOT NULL DEFAULT 'PROD',
 PRIMARY KEY (product_kind, product_id)
);
CREATE TABLE IF NOT EXISTS digifab_test_delivery (
 run_id uuid PRIMARY KEY REFERENCES digifab_test_runs(id), staged boolean NOT NULL DEFAULT false,
 acknowledged boolean NOT NULL DEFAULT false, projected boolean NOT NULL DEFAULT false,
 last_error text, updated_at timestamptz NOT NULL DEFAULT now()
);
