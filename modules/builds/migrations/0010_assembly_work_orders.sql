ALTER TABLE builds_planned ADD COLUMN IF NOT EXISTS assembly jsonb DEFAULT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS builds_assembly_request_key
  ON builds_planned ((assembly->>'request_key')) WHERE assembly IS NOT NULL;

CREATE OR REPLACE FUNCTION builds_keep_assembly_order() RETURNS trigger AS $$
BEGIN
  IF OLD.assembly IS NOT NULL THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Cancel assembly work orders instead of deleting their reservation history';
    END IF;
    IF NEW.build_id <> OLD.build_id OR NEW.qty <> OLD.qty THEN
      RAISE EXCEPTION 'An assembly work order keeps its revision and board quantity';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER builds_keep_assembly_order BEFORE UPDATE OR DELETE ON builds_planned
  FOR EACH ROW EXECUTE FUNCTION builds_keep_assembly_order();
