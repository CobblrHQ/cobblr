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
  /** Live temperatures the manager reports, if any (°C). Cockpit display only. */
  temps?: DeviceTemps | null;
  /** Current job sub-stage label (preheating/leveling/calibrating…), when the
   *  manager reports one. Cockpit display only — answers "why isn't it printing
   *  yet". */
  stage?: string | null;
  /** Live job progress, when this device is mid-print. Cockpit display only. */
  job?: DeviceJob | null;
  /** A webcam/MJPEG/HLS stream URL the MANAGER serves for this device, if it
   *  exposes one. Cobblr only embeds the URL — it never proxies the video
   *  (coordinate-not-control). A user can also set one manually per device. */
  camera_url?: string | null;
  /** OPTIONAL — the full raw status report, when the driver can provide it (the
   *  Bambu LAN driver attaches its MQTT report). Lets the cloud ingest LAN
   *  telemetry as the source of truth for LAN-only / prefer-LAN modes. */
  raw?: Record<string, unknown> | null;
}

/** Live job progress while a device is printing — cockpit display only. */
export interface DeviceJob {
  /** 0..1 fraction printed. */
  fractionPrinted?: number;
  currentLayer?: number;
  /** Estimated seconds remaining. */
  timeLeftSec?: number;
  /** Seconds elapsed so far. */
  durationSec?: number;
}

/** Live temperatures (°C). `actual` is the reading; `target` the setpoint. */
export interface DeviceTemps {
  nozzle?: { actual: number; target?: number } | null;
  bed?: { actual: number; target?: number } | null;
  chamber?: { actual: number; target?: number } | null;
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
  /** Seconds remaining / elapsed, when the manager reports them (OctoPrint's
   *  printTimeLeft / printTime). Surfaced in print-update notifications. */
  timeRemainingSec?: number | null;
  elapsedSec?: number | null;
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
  /** OPTIONAL — ask the manager to ABORT a running job (F-4). Best-effort: a
   *  driver that can't stop a print leaves this undefined, and cancel is then
   *  local-only (the print keeps running — stop it at the machine). */
  cancelJob?(jobId: string): Promise<void>;
  /** OPTIONAL — pause a running job at the manager (cockpit live-control). A
   *  driver that can't pause leaves these undefined; the API returns 501. */
  pauseJob?(jobId: string): Promise<void>;
  /** OPTIONAL — resume a paused job at the manager. */
  resumeJob?(jobId: string): Promise<void>;
  /** OPTIONAL — the ACTUATOR shape: fire a parameterized command-and-forget
   *  (open a valve for N seconds, call a service, flip a relay). No file, no
   *  long-lived job — fire and ack. Drivers that only fabricate (file → job)
   *  leave this undefined; a wire reaches it through the digifab:run-command
   *  action. See docs/BACKLOG.md "Outbound device COMMANDS". */
  runCommand?(command: string, params: Record<string, unknown>): Promise<CommandResult>;
  /** OPTIONAL — declare the live CONTROLS this driver supports for a device
   *  (pause/resume/stop/home/jog/light/temps + custom). The UI renders exactly
   *  these — only what the printer can do — and runs them via runControl.
   *  Drivers that can't control a device leave this undefined / return []. */
  listControls?(deviceId: string): ControlDef[] | Promise<ControlDef[]>;
  /** OPTIONAL — execute a declared control. `params` matches the ControlDef
   *  kind: action {}, toggle {on:boolean}, jog {axis,dist}, number {value}. */
  runControl?(deviceId: string, id: string, params: Record<string, unknown>): Promise<CommandResult>;
  /** OPTIONAL — grab one JPEG camera frame (e.g. Bambu LAN chamber camera over
   *  the bridge). A refreshing still, not a stream. Undefined → no camera. */
  getCameraFrame?(): Promise<Buffer | null>;
  /** OPTIONAL — list the gcode files already on the machine's storage (the
   *  printer's SD/USB), so the UI can show what's there without re-uploading.
   *  Read-only; Cobblr caches it (it changes rarely). Undefined → no file list. */
  listFiles?(deviceId: string): Promise<RemoteFile[]>;
  /** OPTIONAL — start a file ALREADY on the machine's storage (no re-upload),
   *  e.g. one returned by listFiles. Undefined → not supported. */
  printFile?(deviceId: string, name: string): Promise<CommandResult>;
  /** OPTIONAL — slicer metadata for one on-disk file (print-time/filament/layers),
   *  for the file list. Undefined → not supported. */
  fileInfo?(deviceId: string, name: string): Promise<RemoteFileInfo | null>;
}

/** A file already on a machine's own storage (display-only). */
export interface RemoteFile {
  name: string;
  size?: number; // bytes
  modified?: string; // ISO-8601 when the machine reports it
}

/** Slicer metadata for one on-disk file — print-time + filament estimate. */
export interface RemoteFileInfo {
  name: string;
  size?: number;
  printTimeSec?: number;
  filamentMm?: number;
  height?: number;
  layerHeight?: number;
  numLayers?: number;
  generatedBy?: string;
  /** The slicer's embedded preview as a data URI, when the gcode carries one. */
  thumbnail?: string;
}

/** Ack of a command-and-forget actuator call. No job to poll. */
export interface CommandResult {
  ok: boolean;
  /** Optional upstream reference / ack id. */
  ref?: string;
  /** Optional detail (e.g. an error reason). */
  detail?: string;
}

/** A live control a printer supports, declared by its driver. The UI renders by
 *  `kind` and shows only declared controls. Generic across managers; custom
 *  abilities (a chamber light, a purge macro) are just controls with their own id. */
export interface ControlDef {
  /** "pause" | "resume" | "stop" | "home" | "light" | "jog" | "nozzle_temp" | … or a custom id. */
  id: string;
  label: string;
  kind: "action" | "toggle" | "jog" | "number";
  /** UI grouping. */
  group?: "print" | "motion" | "temperature" | "accessory";
  /** Confirm before running (e.g. stop). */
  destructive?: boolean;
  /** jog: which axes + the step options (mm). */
  axes?: string[];
  steps?: number[];
  /** number: unit + bounds for the input. */
  unit?: string;
  min?: number;
  max?: number;
}

/** Config a driver is constructed from (creds decrypted by the caller).
 *  FDM Monster v2 authenticates by login (username+password → JWT) or an
 *  x-api-key; supply whichever the connection stored. */
export interface ManagerConfig {
  baseUrl: string;
  apiKey?: string | null;
  username?: string | null;
  password?: string | null;
  /** Driver-specific config + creds that don't fit the standard fields above
   *  (e.g. the Bambu driver's region/serial/mode + cloud token/access code).
   *  `config` is the connection's public config jsonb; `creds` is the decrypted
   *  credential blob. Generic — the builder stays driver-agnostic. */
  extra?: { config?: Record<string, unknown>; creds?: Record<string, unknown> };
}

export type MachineDriverFactory = (cfg: ManagerConfig) => MachineDriver;
