// The robot-arms family's tables, added to the core's DigifabDB by
// declaration merging, so the core's db.ts never names a family.
import type { ColumnType, Generated } from "kysely";

declare module "../../db.js" {
  interface DigifabDB {
  digifab_arm_units: { machine_id: string; connection_id: string | null; device_id: string | null; maintenance: Generated<"in-service" | "down-for-repair">; maintenance_note: Generated<string>; compatibility: ColumnType<import("./model.js").Compatibility, string | undefined, string>; last_info: ColumnType<import("@cobblr/platform-contract/robot-arm").ArmInfo | null, string | null, string | null>; info_seen_at: Date | null; created_at: Generated<Date>; updated_at: Generated<Date> };
  digifab_arm_programs: { id: Generated<string>; machine_id: string; name: string; revision: string | null; family: string | null; tool: Generated<string>; installation: Generated<string>; source: "controller" | "typed"; first_seen_at: Generated<Date>; last_seen_at: Generated<Date>; missing_since: Date | null };
  digifab_arm_commands: { id: Generated<string>; machine_id: string; operation: import("@cobblr/platform-contract/robot-arm").ArmOperation; program_id: string | null; params: ColumnType<Record<string, unknown>, string, string>; user_id: string | null; via: "page" | "station" | "assistant"; ok: boolean; detail: Generated<string>; created_at: Generated<Date> };
  }
}
export {};
