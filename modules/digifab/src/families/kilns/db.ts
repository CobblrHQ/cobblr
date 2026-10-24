// The kilns family's tables, added to the core's DigifabDB by declaration
// merging, so the core's db.ts never names a family.
import type { ColumnType, Generated } from "kysely";

declare module "../../db.js" {
  interface DigifabDB {
  digifab_kiln_profiles: { machine_id: string; connection_id: string | null; device_id: string | null; schedules: ColumnType<Array<{ name: string; segments: import("./model.js").Firing["schedule"] }>, string, string>; components: ColumnType<import("./model.js").Component[], string, string> };
  digifab_firings: { id: string; machine_id: string; name: string; recipe: ColumnType<import("./model.js").Firing, string, string>; status: Generated<string>; finish_intent: ColumnType<import("./model.js").Finish | null, string | null | undefined, string | null>; connection_id: string | null; device_id: string | null; peak_c: number | null; duration_hours: number | null; started_at: Date | null; ended_at: Date | null; created_at: Generated<Date> };
  }
}
export {};
