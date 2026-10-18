// The robot-arms family's tables, added to the core's DigifabDB by
// declaration merging, so the core's db.ts never names a family.
import type { ColumnType, Generated } from "kysely";

declare module "../../db.js" {
  interface DigifabDB {
    digifab_arm_units: { machine_id: string; connection_id: string | null; device_id: string | null; maintenance: Generated<"in-service" | "down-for-repair">; maintenance_note: Generated<string>; compatibility: ColumnType<import("./model.js").Compatibility, string | undefined, string>; last_info: ColumnType<import("@cobblr/platform-contract/robot-arm").ArmInfo | null, string | null, string | null>; info_seen_at: Date | null; tooling: Generated<string>; event_cursor: ColumnType<string, number | undefined, number>; created_at: Generated<Date>; updated_at: Generated<Date> };
    digifab_arm_approvals: { id: Generated<string>; machine_id: string; program_id: string; revision: string | null; tooling: string; station_id: string; approved_by: string; approved_at: Generated<Date>; expires_at: Date; used_at: Date | null; revoked_at: Date | null };
    digifab_arm_ownership: { machine_id: string; station_id: string; user_id: string; acquired_at: Generated<Date>; expires_at: Date; released_at: Date | null; release_reason: string | null };
    digifab_arm_runs: { id: Generated<string>; machine_id: string; kind: import("@cobblr/platform-contract/robot-arm").ArmRunKind; label: Generated<string>; ref: Generated<string>; target_cycles: number | null; program_id: string | null; approval_id: string; status: Generated<"starting" | "uncertain" | "running" | "ended">; outcome: import("@cobblr/platform-contract/robot-arm").ArmRunOutcome | null; controller_run_id: string | null; cycles: Generated<number>; good: Generated<number>; scrap: Generated<number>; link_lost: "cloud" | "controller" | null; evidence: ColumnType<Record<string, unknown>, string | undefined, string>; started_by: string | null; started_at: Generated<Date>; ended_at: Date | null };
    digifab_arm_events: { machine_id: string; event_id: string; seq: ColumnType<string, number, number>; type: string; payload: ColumnType<import("@cobblr/platform-contract/robot-arm").ArmEvent, string, string>; run_id: string | null; received_at: Generated<Date> };
    digifab_arm_programs: { id: Generated<string>; machine_id: string; name: string; revision: string | null; family: string | null; tool: Generated<string>; installation: Generated<string>; source: "controller" | "typed"; first_seen_at: Generated<Date>; last_seen_at: Generated<Date>; missing_since: Date | null };
    digifab_arm_commands: { id: Generated<string>; machine_id: string; operation: import("@cobblr/platform-contract/robot-arm").ArmOperation; program_id: string | null; params: ColumnType<Record<string, unknown>, string, string>; user_id: string | null; via: "page" | "station" | "assistant"; ok: boolean; detail: Generated<string>; created_at: Generated<Date> };
  }
}
export {};
