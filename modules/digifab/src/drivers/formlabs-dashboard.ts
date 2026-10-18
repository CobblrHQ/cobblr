// EGRESS-FILE: vendor-fixed - the printer maker's dashboard host, written in the code
import { createHash } from "node:crypto";
import { z } from "zod";
import type { MachineDriver, ManagerConfig, RemoteDevice, JobStatus, UploadResult, SubmitResult } from "./types.js";

const ROOT = "https://api.formlabs.com/developer/v1";
const Run = z.object({ guid: z.string(), status: z.string(), currently_printing_layer: z.number().optional(), layer_count: z.number().optional(), estimated_time_remaining_ms: z.number().optional(), elapsed_duration_ms: z.number().optional(), volume_ml: z.number().optional(), material: z.string().optional() });
const Printers = z.array(z.object({ serial: z.string(), alias: z.string().optional(), printer_status: z.object({ status: z.string(), last_pinged_at: z.string().optional(), current_print_run: Run.nullable().optional() }).nullable().optional() }));
type Printer = z.infer<typeof Printers>[number];
const blocked = () => new Error("Formlabs Dashboard is a monitor. Upload, Start, Pause and Stop are unavailable through this documented API. Use the printer's controls.");
function state(value?: string): JobStatus["state"] {
  switch (value?.toUpperCase()) {
    case "PREPRINT": case "PREHEAT": case "PRECOAT": case "POSTCOAT": case "PAUSING": case "ABORTING": case "PRINTING": case "RUNNING": return "printing";
    case "PAUSED": return "paused";
    case "FINISHED": case "COMPLETED": return "completed";
    case "FAILED": case "ERROR": return "failed";
    case "ABORTED": case "CANCELLED": return "cancelled";
    case "QUEUED": return "queued";
    default: return "unknown";
  }
}

export class FormlabsDashboardDriver implements MachineDriver {
  private token: { value: string; until: number } | null = null;
  private cached: { printers: Printer[]; until: number } | null = null;
  private pending: Promise<Printer[]> | null = null;
  constructor(private config: ManagerConfig) {}
  private async request(path: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try { response = await fetch(ROOT + path, { ...init, redirect: "error", signal: AbortSignal.timeout(10000) }); }
    catch { throw new Error("Formlabs Dashboard did not respond. Check the connection."); }
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "Formlabs Dashboard declined these credentials. Check the client ID and secret in Developer Tools." : response.status === 429 ? "Formlabs Dashboard reached its request limit. Wait before reading it again." : "Formlabs Dashboard could not return this reading.");
    try { return await response.json(); } catch { throw new Error("Formlabs Dashboard returned an unreadable reading."); }
  }
  private async accessToken(): Promise<string> {
    if (this.token && this.token.until > Date.now()) return this.token.value;
    if (!this.config.username || !this.config.password) throw new Error("Enter your own Formlabs Developer Tools client ID and client secret.");
    const value = z.object({ access_token: z.string().min(1), expires_in: z.number().positive() }).parse(await this.request("/o/token/", { method: "POST", body: new URLSearchParams({ grant_type: "client_credentials", client_id: this.config.username, client_secret: this.config.password }) }));
    this.token = { value: value.access_token, until: Date.now() + Math.max(1, value.expires_in - 60) * 1000 };
    return this.token.value;
  }
  private async printers(): Promise<Printer[]> {
    if (this.cached && this.cached.until > Date.now()) return this.cached.printers;
    if (!this.pending) {
      this.pending = (async () => {
        const token = await this.accessToken();
        const printers = Printers.parse(await this.request("/printers/", { method: "GET", headers: { Authorization: `Bearer ${token}` } }));
        this.cached = { printers, until: Date.now() + 30000 }; return printers;
      })().finally(() => { this.pending = null; });
    }
    return this.pending;
  }
  async testConnection() {
    try { const printers = await this.printers(); return { ok: true, detail: `${printers.length} Formlabs printer${printers.length === 1 ? "" : "s"}. Dashboard monitoring only.`, capabilities: { routing: false } }; }
    catch (error) { return { ok: false, detail: error instanceof Error ? error.message : "Formlabs Dashboard is unavailable.", capabilities: { routing: false } }; }
  }
  async listDevices(): Promise<RemoteDevice[]> {
    return (await this.printers()).map(printer => {
      const reading = printer.printer_status, run = reading?.current_print_run;
      const stale = !reading?.last_pinged_at || (!Number.isFinite(Date.parse(reading.last_pinged_at)) || Date.now() - Date.parse(reading.last_pinged_at) > 5 * 60000);
      return { id: printer.serial, name: printer.alias || printer.serial, enabled: true, state: stale ? "offline" : state(run?.status ?? reading?.status), stage: "Dashboard monitoring only", job: run ? { currentLayer: run.currently_printing_layer, fractionPrinted: run.layer_count && run.currently_printing_layer != null ? run.currently_printing_layer / run.layer_count : undefined, timeLeftSec: run.estimated_time_remaining_ms != null ? run.estimated_time_remaining_ms / 1000 : undefined } : null, raw: { monitorOnly: true, resin: true, status: reading?.status, resin_ml: run?.volume_ml, material: run?.material } };
    });
  }
  async getJobStatus(jobId: string): Promise<JobStatus> {
    const run = (await this.printers()).flatMap(printer => printer.printer_status?.current_print_run ? [printer.printer_status.current_print_run] : []).find(run => run.guid === jobId);
    return { jobId, state: run ? state(run.status) : "unknown", progress: run?.layer_count && run.currently_printing_layer != null ? run.currently_printing_layer / run.layer_count : null };
  }
  async setDeviceEnabled() { throw blocked(); }
  async uploadFile(): Promise<UploadResult> { throw blocked(); }
  async submitJob(): Promise<SubmitResult> { throw blocked(); }
  async resolvePlacement() { return { kind: "none" as const, matchedName: null, deviceIds: [] }; }
}

const accounts = new Map<string, { fingerprint: string; driver: FormlabsDashboardDriver }>();
export function formlabsDriver(config: ManagerConfig, connectionId: string): FormlabsDashboardDriver {
  const fingerprint = createHash("sha256").update(JSON.stringify([config.username, config.password])).digest("hex");
  const existing = accounts.get(connectionId);
  if (existing?.fingerprint === fingerprint) return existing.driver;
  if (accounts.size >= 1000) accounts.delete(accounts.keys().next().value!);
  const driver = new FormlabsDashboardDriver(config); accounts.set(connectionId, { fingerprint, driver }); return driver;
}
