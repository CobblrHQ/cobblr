// MachineDriver — the common interface every print-farm backend implements.
// Pure TypeScript (no platform deps) so it unit-tests in isolation. companion app's
// MachineDriver shape, made routing-aware for FDM Monster's print-file
// routing (fdm-monster/fdm-monster#5303): submitJob is "place this file"
// (resolve → queue, or explicit printer) rather than "submit to printer N".

export interface RemoteDevice {
  /** The id inside the farm system (stored locally as remote_device_id). */
  id: string;
  name: string;
  enabled: boolean;
  /** Free-form upstream state ("operational", "printing", "offline", …). */
  state?: string | null;
  /** Printer tags/groups (FDM Monster tags) — used for tag routing. */
  tags?: string[];
}

export type JobState =
  | "queued"
  | "printing"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | "awaiting-assignment" // routed to a tag/ambiguous — needs a manual printer pick
  | "unknown";

export interface JobStatus {
  jobId: string;
  state: JobState;
  /** 0..1 when known. */
  progress?: number | null;
  deviceId?: string | null;
  /** The raw upstream payload, for debugging / fields we don't model. */
  raw?: unknown;
}

/** Where a file resolves, from FDM Monster's print-file-routing/resolve. */
export type PlacementKind = "printer" | "tag" | "none" | "ambiguous";
export interface PlacementResolution {
  kind: PlacementKind;
  /** The matched printer or tag name, if any. */
  matchedName: string | null;
  /** The printer ids the target resolves to (1 for a printer, N for a tag). */
  deviceIds: string[];
}

export interface UploadResult {
  fileId: string;
  filename: string;
}

export interface SubmitResult {
  /** The farm's job id, when a job was actually queued on a printer. */
  jobId: string | null;
  /** The printer it landed on (null when awaiting manual assignment). */
  deviceId: string | null;
  /** True when queued on exactly one printer; false when awaiting a pick. */
  queued: boolean;
  status: "queued" | "awaiting-assignment";
}

/** What the connected server can do — probed at testConnection. */
export interface ManagerCapabilities {
  /** Has the print-file-routing API (resolve/queue) — the author's PR / newer FDMM. */
  routing: boolean;
}

export interface ConnectionResult {
  ok: boolean;
  detail?: string;
  capabilities: ManagerCapabilities;
}

/** Args for placing a file. Exactly one of printer/tag is the target;
 *  omit both to let the server route by the file's own fdmm_target. */
export interface SubmitArgs {
  fileId: string;
  /** Explicit printer id → classic submit (the companion app path). */
  deviceId?: string | null;
  /** A tag name → routed to the tag's printer set (may await assignment). */
  tag?: string | null;
}

export interface MachineDriver {
  /** Liveness + capability probe. Read-only. */
  testConnection(): Promise<ConnectionResult>;
  /** Pull the printer list (for the one-time machine↔printer mapping). Read-only. */
  listDevices(): Promise<RemoteDevice[]>;
  /** Enable/disable a printer (outbound state sync). */
  setDeviceEnabled(deviceId: string, enabled: boolean): Promise<void>;
  /** Upload a sliced file; returns the farm's file id. */
  uploadFile(file: Uint8Array, filename: string): Promise<UploadResult>;
  /** Preview where an uploaded file would route (routing API). Read-only. */
  resolvePlacement(fileId: string): Promise<PlacementResolution>;
  /** Place a file: explicit printer (classic) or routed (queue). */
  submitJob(args: SubmitArgs): Promise<SubmitResult>;
  /** Poll a job's status. Read-only. */
  getJobStatus(jobId: string): Promise<JobStatus>;
}

/** Config a driver is constructed from (creds decrypted by the caller).
 *  FDM Monster v2 authenticates by login (username+password → JWT) or an
 *  x-api-key; supply whichever the connection stored. */
export interface ManagerConfig {
  baseUrl: string;
  apiKey?: string | null;
  username?: string | null;
  password?: string | null;
}

export type MachineDriverFactory = (cfg: ManagerConfig) => MachineDriver;
