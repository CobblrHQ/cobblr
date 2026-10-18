// The embroidery family's tables, added to the core's DigifabDB by declaration
// merging, so the core's db.ts never names a family.
import type { Generated } from "kysely";

declare module "../../db.js" {
  interface DigifabDB {
  digifab_embroidery_machines: {id:Generated<string>;config:import("./embroidery-runs.js").EmbroideryMachine;created_at:Generated<Date>;updated_at:Generated<Date>};
  digifab_embroidery_designs: {id:Generated<string>;name:string;file_id:string;source_hash:string;design:import("./embroidery-design.js").EmbroideryDesign;summary:import("./embroidery-design.js").EmbroiderySummary;created_at:Generated<Date>};
  digifab_embroidery_runs: {job_id:string;machine_id:string;design_id:string;plan:import("./embroidery-runs.js").EmbroideryPlan;started_at:Generated<Date|null>;interrupted:Generated<boolean>;report:Generated<import("./embroidery-runs.js").EmbroideryReport|null>;stock_recorded_at:Generated<Date|null>;consumed_at:Generated<Date|null>;created_at:Generated<Date>};
  digifab_embroidery_thread_claims: {part_id:string;job_id:string};
  }
}
export {};
