import { api } from "../../lib/api";
import type { ArmCommand, ArmInfo, ArmState } from "@cobblr/platform-contract/robot-arm";
export interface ArmProgram { id: string; machine_id: string; name: string; revision: string | null; family: string | null; tool: string; installation: string; source: "controller" | "typed"; missing_since: string | null; last_seen_at: string }
export interface Evidence { tested_on: string; by: string; setup: string; notes: string }
export interface ArmCompatibility { controller_generation: string; firmware: string; options: string[]; interfaces: Array<{ name: string; enabled: boolean; read: boolean; write: boolean }>; simulator_evidence: Evidence | null; hardware_evidence: Evidence | null }
export interface ArmCommandRow { id: string; operation: string; params: Record<string, unknown>; via: "page" | "station" | "assistant"; ok: boolean; detail: string; created_at: string; user_id: string | null }
export interface ArmView {
 unit: null | { machine_id: string; connection_id: string | null; device_id: string | null; maintenance: "in-service" | "down-for-repair"; maintenance_note: string; last_info: ArmInfo | null; info_seen_at: string | null };
 state: ArmState | null; connection_error: string | null; programs: ArmProgram[]; families: Array<{ family: string | null; programs: ArmProgram[] }>;
 compatibility: ArmCompatibility | null; support: "untested" | "simulator" | "hardware"; items: ArmCommandRow[]; total: number;
}
export const readArm = (slug: string, machine: string, offset: number) => api.request<ArmView>("GET", `/orgs/${slug}/modules/digifab/arms/${machine}?offset=${offset}&limit=20`);
export const setupArm = (slug: string, machine: string, body: { connection_id: string | null; device_id: string | null }) => api.request("POST", `/orgs/${slug}/modules/digifab/arms/${machine}/setup`, body);
export const refreshArm = (slug: string, machine: string) => api.request<{ programs_listed: boolean; detail?: string }>("POST", `/orgs/${slug}/modules/digifab/arms/${machine}/refresh`, {});
export const addProgram = (slug: string, machine: string, body: { name: string; revision: string | null; family: string | null; tool: string; installation: string }) => api.request("POST", `/orgs/${slug}/modules/digifab/arms/${machine}/programs`, body);
export const editProgram = (slug: string, id: string, body: { family?: string | null; tool?: string; installation?: string }) => api.request("PATCH", `/orgs/${slug}/modules/digifab/arms/programs/${id}`, body);
export const saveCompatibility = (slug: string, machine: string, body: ArmCompatibility) => api.request("PATCH", `/orgs/${slug}/modules/digifab/arms/${machine}/compatibility`, body);
export const setMaintenance = (slug: string, machine: string, body: { maintenance: "in-service" | "down-for-repair"; note: string }) => api.request("PATCH", `/orgs/${slug}/modules/digifab/arms/${machine}/maintenance`, body);
export const commandArm = (slug: string, machine: string, command: ArmCommand, extra: { station_token?: string; confirmed?: boolean } = {}) => api.request<{ ok: boolean; detail?: string }>("POST", `/orgs/${slug}/modules/digifab/arms/${machine}/command`, { command, ...extra });
