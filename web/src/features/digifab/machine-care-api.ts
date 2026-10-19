import { api } from "../../lib/api";
export interface Alarm { id: string; machine_id: string; source: "arm" | "machine"; code: string; text: string; severity: "info" | "warning" | "error"; program: string | null; step: string | null; camera_file_id: string | null; occurred_at: string; escalation_level: number; acknowledged_by: string | null; acknowledged_at: string | null; note: string }
export interface Utilisation { since: string; window_s: number; run_s: number; idle_s: number; fault_s: number; unknown_s: number; coverage: number; now: { state: string; detail: string; seen_at: string } | null; oee: { available: boolean; needs: string[] } }
export interface CareView { machine_id: string; utilisation: Utilisation; items: Alarm[]; total: number }
export interface Escalation { operators: string[]; supervisors: string[]; integrators: string[]; supervisor_after_minutes: number; integrator_after_minutes: number }
export const readCare = (slug: string, machine: string, hours: number, offset: number) => api.request<CareView>("GET", `/orgs/${slug}/modules/digifab/care/${machine}?hours=${hours}&offset=${offset}&limit=20`);
export const acknowledgeAlarm = (slug: string, alarm: string, note: string) => api.request<Alarm>("POST", `/orgs/${slug}/modules/digifab/care/alarms/${alarm}/ack`, { note });
export const readEscalation = (slug: string) => api.request<Escalation>("GET", `/orgs/${slug}/modules/digifab/care/alarm-escalation`);
export const saveEscalation = (slug: string, body: Escalation) => api.request("POST", `/orgs/${slug}/modules/digifab/care/alarm-escalation`, body);
export const setReorderLevel = (slug: string, part: string, min_qty: number | null) => api.request("PATCH", `/orgs/${slug}/modules/inventory/parts/${part}`, { min_qty });
