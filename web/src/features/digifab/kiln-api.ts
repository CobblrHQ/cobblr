import { api } from "../../lib/api";
export interface Segment { ramp_c_per_hour: number; target_c: number; hold_minutes: number }
export interface Piece { kind: string; id: string; title?: string }
export interface KilnProfile { connection_id: string | null; device_id: string | null; components: Array<{ name: string; interval_hours: number; replaced_at_hours: number }>; schedules: Array<{ name: string; segments: Segment[] }> }
export interface FiringRecipe { name: string; cone: string; schedule: Segment[]; pieces: Piece[]; glazes: Array<{ part_id: string; kind?: string; ml: number }>; notes: string }
export interface FinishIntent { peak_c: number; duration_hours: number; outcome: "completed" | "failed" | "stopped" }
export interface FiringLog { id: string; name: string; recipe: FiringRecipe; finish_intent?: FinishIntent | null; status: string; peak_c: number | null; duration_hours: number | null; ended_at: string | null }
export interface KilnView { profile: KilnProfile | null; firing_hours: number; reminders: Array<{ name: string; hours_used: number; interval_hours: number }>; items: FiringLog[]; total: number; connection_error: string | null; telemetry: null | { temperature_c: number; segment: number | null; segments: number; elapsed_sec: number; remaining_sec: number | null; progress: number | null; schedule_name: string; running: boolean; errors: string[] | null } }
export const readKiln = (slug: string, machine: string, offset: number) => api.request<KilnView>("GET", `/orgs/${slug}/modules/digifab/kilns/${machine}?offset=${offset}&limit=20`);
export const saveKiln = (slug: string, machine: string, profile: KilnProfile) => api.request("POST", `/orgs/${slug}/modules/digifab/kilns/${machine}/profile`, profile);
export const createFiring = (slug: string, machine: string, id: string, firing: FiringRecipe) => api.request("POST", `/orgs/${slug}/modules/digifab/kilns/${machine}/firings`, { id, firing });
export const finishFiring = (slug: string, id: string, finish: { peak_c: number; duration_hours: number; outcome: string }) => api.request("POST", `/orgs/${slug}/modules/digifab/kilns/firings/${id}/finish`, finish);
export const controlFiring = (slug: string, id: string, operation: "start" | "stop", station_token: string) => api.request("POST", `/orgs/${slug}/modules/digifab/kilns/firings/${id}/control`, { operation, station_token });
