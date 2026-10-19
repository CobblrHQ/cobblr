// A cell's tables (migrations/0093_robot_cells.sql), added to the core's
// DigifabDB by declaration merging like the arms' (../db.ts).
import type { ColumnType, Generated } from "kysely";
import type { CellEvent } from "@cobblr/platform-contract/robot-cell";
import type { CellDefinition } from "./model.js";

declare module "../../../db.js" {
  interface DigifabDB {
    digifab_cells: { machine_id: string; connection_id: string | null; device_id: string | null; operators: ColumnType<string[], string | undefined, string>; definition: ColumnType<CellDefinition, string | undefined, string>; output_part_id: string | null; event_cursor: ColumnType<string, number | undefined, number>; created_at: Generated<Date>; updated_at: Generated<Date> };
    digifab_cell_members: { cell_id: string; role: string; kind: "arm" | "machine" | "sensor"; machine_id: string | null; connection_id: string; device_id: string };
    digifab_cell_jobs: { id: Generated<string>; cell_id: string; label: Generated<string>; definition: ColumnType<Record<string, unknown>, string, string>; definition_hash: string; status: Generated<"starting" | "uncertain" | "running" | "paused" | "ended">; outcome: "completed" | "aborted" | "unknown" | "not-started" | null; paused_on: "timeout" | "fault" | null; paused_reason: string | null; cycles: Generated<number>; parts: Generated<number>; stock_cycles: Generated<number>; last_cycle_ms: number | null; detail: Generated<string>; station_id: string | null; started_by: string | null; started_at: Generated<Date>; ended_at: Date | null };
    digifab_cell_steps: { job_id: string; cycle: number; step: number; kind: string; role: string; outcome: "done" | "failed" | null; detail: string | null; duration_ms: number | null; started_at: Date; ended_at: Date | null };
    digifab_cell_events: { cell_id: string; event_id: string; seq: ColumnType<string, number, number>; type: string; payload: ColumnType<CellEvent, string, string>; job_id: string | null; received_at: Generated<Date> };
    digifab_cell_commands: { id: Generated<string>; cell_id: string; operation: "start" | "resume" | "stop"; job_id: string | null; user_id: string | null; via: "page" | "station" | "assistant"; ok: boolean; detail: Generated<string>; created_at: Generated<Date> };
  }
}
export {};
