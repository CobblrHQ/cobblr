// The printers family's tables, added to the core's DigifabDB by declaration
// merging, so the core's db.ts never names a family.
import type { Generated } from "kysely";

declare module "../../db.js" {
  interface DigifabDB {
  digifab_bambu_status: DigifabBambuStatusTable;
  digifab_resin_prints: {
    job_id: string; connection_id: string; device_id: string; review_file_id: string;
    phase: Generated<string>; snapshot: import("./resin-prints.js").ResinSnapshot;
    stock_error: string | null; wash_done: Generated<boolean>; cure_done: Generated<boolean>;
    created_at: Generated<Date>; updated_at: Generated<Date>;
  };
  }
}
export interface DigifabBambuStatusTable {
  connection_id: string;
  serial: string;
  state: string | null;
  stage: string | null;
  nozzle_actual: number | null;
  nozzle_target: number | null;
  bed_actual: number | null;
  bed_target: number | null;
  chamber_actual: number | null;
  chamber_target: number | null;
  progress: number | null;
  remaining_min: number | null;
  layer_num: number | null;
  total_layers: number | null;
  /** The full live MQTT `print` object, raw. */
  report: Record<string, unknown> | null;
  updated_at: Generated<Date>;
}
