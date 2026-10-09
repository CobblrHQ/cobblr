CREATE UNIQUE INDEX IF NOT EXISTS inventory_assembly_output_once ON inventory_consumption(source_id) WHERE source_kind = 'assembly-output';
