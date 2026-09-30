// The location-bearing tenant tables and the entity-kind each maps to. Kinds are
// the BASE kinds; instances (3d-printers:item …) are a partition of the same
// row, so the base kind is the right containee_kind for the row's table.
export const LOCATED_TABLES: Array<{ table: string; kind: string }> = [
  { table: "inventory_parts", kind: "inventory:part" },
  { table: "machines_machines", kind: "machines:machine" },
  { table: "assets_assets", kind: "assets:asset" },
  { table: "records_records", kind: "records:record" },
];
