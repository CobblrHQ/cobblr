-- PHASE: contract
-- SAFE WHEN: existing APIs read and write numeric quantities as decimal strings.
-- Threshold precision widens to match quantities while the integer range stays the same.
ALTER TABLE inventory_parts ALTER COLUMN min_qty TYPE numeric(18,9);
ALTER TABLE inventory_parts ADD COLUMN stock_revision integer NOT NULL DEFAULT 0;

CREATE FUNCTION inventory_stock_native_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.qty, NEW.min_qty, NEW.unit, NEW.metadata, NEW.state, NEW.archived)
     IS DISTINCT FROM ROW(OLD.qty, OLD.min_qty, OLD.unit, OLD.metadata, OLD.state, OLD.archived) THEN
    NEW.stock_revision := OLD.stock_revision + 1;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER inventory_stock_native_revision BEFORE UPDATE OF qty, min_qty, unit, metadata, state, archived
ON inventory_parts FOR EACH ROW EXECUTE FUNCTION inventory_stock_native_revision();

CREATE TABLE inventory_stock (
  part_id uuid PRIMARY KEY REFERENCES inventory_parts(id) ON DELETE CASCADE,
  config jsonb NOT NULL DEFAULT '{"shape":"count","unit":"each","low_threshold":0}'::jsonb,
  shape text GENERATED ALWAYS AS (config->>'shape') STORED,
  used numeric NOT NULL DEFAULT 0 CHECK (used >= 0),
  revision integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (shape IN ('sheet','roll','spool','liquid','wearing-tool','count'))
);
INSERT INTO inventory_stock (part_id, config)
SELECT part_id, '{"shape":"sheet","low_threshold":0}'::jsonb FROM inventory_sheet_area
ON CONFLICT (part_id) DO NOTHING;

CREATE TABLE inventory_stock_uses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  part_id uuid NOT NULL REFERENCES inventory_parts(id) ON DELETE CASCADE,
  source text NOT NULL,
  verdict text NOT NULL CHECK (verdict IN ('good','scrap','recount')),
  amount numeric NOT NULL,
  unit text NOT NULL,
  remaining numeric NOT NULL CHECK (remaining >= 0),
  by_user uuid,
  at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (part_id, source)
);
CREATE INDEX inventory_stock_uses_part_at ON inventory_stock_uses (part_id, at DESC);
CREATE TABLE inventory_stock_loaded (
  station text NOT NULL,
  slot text NOT NULL DEFAULT 'stock',
  part_id uuid NOT NULL REFERENCES inventory_parts(id) ON DELETE CASCADE,
  by_user uuid NOT NULL,
  loaded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (station, slot),
  UNIQUE (part_id)
);
ALTER TABLE inventory_consumption ADD COLUMN unit text;
UPDATE inventory_consumption c SET unit = p.unit FROM inventory_parts p WHERE p.id = c.part_id;

CREATE FUNCTION inventory_stock_sheet_birth() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF jsonb_typeof(NEW.metadata->'laser_sheet') = 'object'
     OR (NEW.metadata ?& ARRAY['material','width_mm','height_mm','thickness_mm']) THEN
    INSERT INTO inventory_stock (part_id, config)
    VALUES (NEW.id, '{"shape":"sheet","low_threshold":0}'::jsonb)
    ON CONFLICT (part_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER inventory_stock_sheet_birth AFTER INSERT OR UPDATE OF metadata
ON inventory_parts FOR EACH ROW EXECUTE FUNCTION inventory_stock_sheet_birth();
INSERT INTO inventory_stock (part_id, config)
SELECT id, '{"shape":"sheet","low_threshold":0}'::jsonb FROM inventory_parts p
WHERE jsonb_typeof(metadata->'laser_sheet') = 'object'
   OR metadata ?& ARRAY['material','width_mm','height_mm','thickness_mm']
ON CONFLICT (part_id) DO NOTHING;

CREATE FUNCTION inventory_stock_unit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM inventory_stock s WHERE s.part_id = NEW.id
      AND s.shape IN ('roll','spool','liquid')
      AND s.config->>'unit' IS DISTINCT FROM NEW.unit) THEN
    RAISE EXCEPTION 'Keep this stock''s measured unit. Recount through stock shapes.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER inventory_stock_unit_guard BEFORE UPDATE OF unit ON inventory_parts
FOR EACH ROW EXECUTE FUNCTION inventory_stock_unit_guard();
