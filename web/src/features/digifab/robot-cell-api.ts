import { api } from "../../lib/api";
import type { CellState, CellStep } from "@cobblr/platform-contract/robot-cell";
export type CellKind = "arm" | "machine" | "sensor";
export interface CellMember { role: string; kind: CellKind; machine_id: string | null; connection_id: string; device_id: string; title?: string | null }
export interface CellDefinition { label: string; steps: CellStep[]; cycles: number | null; parts_per_cycle: number }
export interface CellJob { id: string; label: string; status: "starting" | "uncertain" | "running" | "paused" | "ended"; outcome: "completed" | "aborted" | "unknown" | "not-started" | null; paused_on: "timeout" | "fault" | null; paused_reason: string | null; cycles: number; parts: number; last_cycle_ms: number | null; detail: string; started_at: string; ended_at: string | null }
export interface CellStepRow { job_id: string; cycle: number; step: number; kind: string; role: string; outcome: "done" | "failed" | null; detail: string | null; duration_ms: number | null; started_at: string }
export interface CellCommandRow { id: string; operation: string; via: "page" | "station" | "assistant"; ok: boolean; detail: string; created_at: string }
export interface CellView {
 cell: null | { machine_id: string; connection_id: string | null; device_id: string | null; operators: string[]; definition: CellDefinition; output_part_id: string | null };
 members: CellMember[]; state: CellState | null; connection_error: string | null; open_job: CellJob | null; jobs: CellJob[]; steps: CellStepRow[]; hash: string | null; items: CellCommandRow[]; total: number;
}
export interface MemberInput { role: string; kind: CellKind; machine_id: string | null; connection_id: string | null; device_id: string | null }
export const readCell = (slug: string, machine: string, offset: number) => api.request<CellView>("GET", `/orgs/${slug}/modules/digifab/cells/${machine}?offset=${offset}&limit=20`);
export const setupCell = (slug: string, machine: string, body: { connection_id: string | null; device_id: string | null; members: MemberInput[] }) => api.request("POST", `/orgs/${slug}/modules/digifab/cells/${machine}/setup`, body);
export const saveDefinition = (slug: string, machine: string, body: CellDefinition) => api.request("PATCH", `/orgs/${slug}/modules/digifab/cells/${machine}/definition`, body);
export const setOperators = (slug: string, machine: string, operators: string[]) => api.request("PATCH", `/orgs/${slug}/modules/digifab/cells/${machine}/operators`, { operators });
export const setOutput = (slug: string, machine: string, output_part_id: string | null) => api.request("PATCH", `/orgs/${slug}/modules/digifab/cells/${machine}/output`, { output_part_id });
export const startCellJob = (slug: string, machine: string, body: { station_token: string; definition_hash: string; cell_clear: true }) => api.request<CellJob>("POST", `/orgs/${slug}/modules/digifab/cells/${machine}/jobs`, body);
export const resumeCellJob = (slug: string, machine: string, station_token: string) => api.request("POST", `/orgs/${slug}/modules/digifab/cells/${machine}/resume`, { station_token });
export const stopCellJob = (slug: string, machine: string, extra: { station_token?: string } = {}) => api.request<{ ok: boolean; detail?: string }>("POST", `/orgs/${slug}/modules/digifab/cells/${machine}/stop`, extra);
export const endCellJob = (slug: string, job: string, body: { outcome: "unknown" | "aborted"; note: string }) => api.request("POST", `/orgs/${slug}/modules/digifab/cells/jobs/${job}/end`, body);
