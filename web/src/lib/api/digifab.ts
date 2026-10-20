import type { PlatformResolvedEntity } from "./placement";
import type { CutterProfile, CutterProgram } from "@cobblr/platform-contract/cutter-program";
import { ApiError, getToken, request, upload } from "./client";
import { getImpersonationToken } from "../impersonation";
import type { CancelResult } from "../digifab-cancel";
import type { LaserCommission, LaserSetup } from "@cobblr/platform-contract/laser-setup";

// Sync connectors (mirror an external system into a Cobblr entity kind).
// A connected edge bridge for the workspace. `bridge: null` = the default
// (no-id) bridge; a string = a named bridge.
export interface EdgeBridge {
  bridge: string | null;
  /** What a person calls it; null for a bridge installed before names. */
  name?: string | null;
  connected: boolean;
  last_seen: number | null;
  version?: string | null;
  hostname?: string | null;
  /** The addresses it says it will reach (BRIDGE_ALLOW on the box); null or
   *  absent: whatever the workspace points it at. */
  allowlist?: string[] | null;
  /** Cobblr knows its key and can cut it off. */
  can_disconnect?: boolean;
}

/** A bridge Cobblr reaches DIRECTLY (LAN, tailnet, same machine), derived from
 *  the connections pointing at it — there is no bridge table, because a
 *  connection's base_url already carries the address. */
export interface DirectEdgeBridge {
  origin: string;
  label: string;
  instances: number;
  auth: "token" | "none" | "mixed";
  /** Last success FROM COBBLR'S SERVER. Whether YOUR BROWSER can reach it is a
   *  different question with a different answer, and the UI must not conflate
   *  them: a bench on a tailnet host is reachable by a self-hosted Cobblr and
   *  not by a laptop elsewhere. */
  last_ok_at: string | null;
  last_status: string | null;
  connection_ids: string[];
}

/** A printer's filament slots and the spool loaded in each. */
export interface DigifabLoaded {
  slots: number;
  loaded: Array<{ slot: string; thing: PlatformResolvedEntity }>;
}

export interface DigifabFailureConfig {
  enabled: boolean;
  threshold: number;
  sample_interval_sec: number;
  auto_pause: boolean;
  backend: "auto" | "edge" | "llm" | "detector";
  detector_id: string | null;
}
export interface DigifabFailureStatus {
  watching: boolean; score: number; samples: number;
  last_probability: number | null; last_source: "edge" | "llm" | "detector" | null;
  paused: boolean; paused_at: string | null; last_sample_at: string | null;
}
export interface DigifabFailureCheck {
  available: boolean; reason?: string;
  probability?: number; source?: "edge" | "llm" | "detector"; would_trip?: boolean; projected_score?: number;
}

/** An external detection service the operator can point at a base URL. */
export interface DigifabDetectorCatalogEntry {
  key: string; name: string; summary?: string; shape: "frame-scorer" | "camera-watcher";
}
/** A configured detector connection (credentials never returned). */
export interface DigifabDetector {
  id: string; key: string; label: string;
  /** Null once the detector moved to its connection: the address lives there. */
  base_url: string | null;
  /** The service connection holding its address and key, once moved. */
  service_connection_id?: string | null;
  config: { camera_map?: Record<string, string> } & Record<string, unknown>;
  enabled: boolean; has_credentials: boolean | null;
  created_at?: string; updated_at?: string;
}
export interface DigifabDetectorInput {
  key: string; label: string; base_url: string;
  api_key?: string | null; config?: Record<string, unknown>; enabled?: boolean;
}
/** A camera the detector service reports (the import list, for the link picker). */
export interface DigifabDetectorCamera { id: string; name?: string; online?: boolean; printerId?: string; }
/** A provider a printer can be registered under, + its config form (JSON Schema). */
export interface DigifabDetectorProvider { id: string; label?: string; schema?: { properties?: Record<string, { title?: string; secret?: boolean; placeholder?: string; format?: string }>; required?: string[] } | null; }
/** A generic mirror mapping: a Cobblr connection type → a detector provider. */
export interface DigifabDetectorMapping { from: string; provider: string; perDevice: boolean; }
/** A printer the detector owns, with live print state (for consumption). */
export interface DigifabDetectorPrinter { id: string; name?: string; status?: string; progress?: number | null; }

export interface DigifabHistory {
  days: number;
  /** Dense daily trend over the window (zero-filled) — jobs + Bambu cloud tasks. */
  series?: { date: string; completed: number; failed: number; filament_g: number; cost?: number | null }[];
  /** `cost` sums the priced prints in `currency`; `unpriced` counts the finished prints no price could be put on. */
  summary: { total: number; completed: number; failed: number; cancelled: number; filament_g: number; hours: number; cost?: number | null; unpriced?: number };
  currency?: string;
  by_device: { name: string; total: number; completed: number; failed: number; filament_g: number; cost?: number | null; unpriced?: number }[];
  recent: { id: string; file_ref: string; metadata?: Record<string, unknown>; sub_label?: string | null; cover?: string | null; device: string; connection_id?: string | null; device_id?: string | null; status: string; filament_g: number | null; cost?: number | null; cost_currency?: string | null; at: string; duration_s?: number }[];
}

export interface DigifabLibraryItem {
  id: string;
  name: string;
  file_id: string;
  thumbnail_file_id: string | null;
  kind: string;
  size_bytes: number;
  plate_count: number;
  notes: string | null;
  /** Slicer metadata parsed at upload: est time / material / layer / ppp. */
  metadata?: {
    laser_material?: LaserMaterialTag;
    laser_layout?: LaserJobLayout; cutter_plan?: boolean; mirrored?: boolean; mirror_label?: string;
    resin_ml?: number;
    layers?: number;
    exposure_sec?: number;
    estimated_sec?: number;
    material?: string;
    layer_height_mm?: number;
    nozzle_mm?: number;
    filament_g?: number;
    parts_per_plate?: number;
    slicer?: string;
  };
  created_at: string;
  updated_at: string;
}

export interface DigifabAmsSlot { id: string; type: string | null; color: string | null; remain: number | null; brand: string | null }
export interface DigifabDeviceDetail {
  live: boolean;
  updated_at?: string;
  lan?: { applicable: boolean; configured: boolean; host?: string; mode?: "cloud" | "prefer_lan" | "lan_only"; camera?: boolean };
  telemetry: {
    nozzle: number | null; nozzle_target: number | null;
    bed: number | null; bed_target: number | null;
    chamber: number | null;
    light: string | null;
    speed_level: number | null;
    nozzle_diameter: string | null; nozzle_type: string | null;
    wifi: string | null; gcode_state: string | null;
    firmware_update: boolean; hms_count: number;
    ams: DigifabAmsSlot[];
  } | null;
  job?: { fractionPrinted?: number; currentLayer?: number; timeLeftSec?: number; durationSec?: number } | null;
}

export interface DigifabFileInfo {
  name: string;
  size?: number;
  printTimeSec?: number;
  filamentMm?: number;
  height?: number;
  layerHeight?: number;
  numLayers?: number;
  generatedBy?: string;
  thumbnail?: string;
}

export interface DigifabControl {
  id: string;
  label: string;
  kind: "action" | "toggle" | "jog" | "number";
  group?: "print" | "motion" | "temperature" | "accessory";
  destructive?: boolean;
  axes?: string[];
  steps?: number[];
  unit?: string;
  min?: number;
  max?: number;
}

export interface EdgeShare {
  id: string;
  label: string;
  scope: "read" | "write";
  status: "pending" | "active" | "revoked" | "expired";
  machines: { id: string; label: string }[];
  grantees: string[];
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
}

export interface DigifabConnection {
  id: string;
  type: string;
  label: string;
  base_url: string;
  /** Non-secret display config (e.g. a Bambu connection's `mode`). */
  config?: Record<string, unknown>;
  enabled: boolean;
  capabilities: { routing?: boolean } & Record<string, unknown>;
  last_sync_at: string | null;
  last_sync_status: string | null;
  created_at: string;
  updated_at: string;
}

export type DigifabDeviceClass = "printing" | "idle" | "paused" | "complete" | "offline" | "error" | "unknown";

export interface DigifabDeviceTemp {
  actual: number;
  target?: number;
}
export type BambuMode = "cloud" | "lan" | "hybrid";
export interface BambuModeCapabilities { monitor: boolean; control: boolean; available: boolean; note: string }
export interface BambuDiscoveredDevice { dev_id: string; name: string; model?: string; online: boolean; print_status?: string }
export type BambuLoginResponse =
  | { status: "need_email_code"; session: string }
  | { status: "need_tfa"; session: string }
  | { status: "ready"; session: string; devices: BambuDiscoveredDevice[] };

export interface DigifabFleetDevice {
  monitor_only?: boolean;
  print_process?: "resin" | null;
  station_kind?: "laser" | "print" | "cnc" | "cutter" | "bench" | "production-test";
  laser_backend?: "gcode" | "ruida" | "galvo" | null;
  laser_setup?: boolean;
  lightburn_readiness?: { api: { ready: boolean; fix: string }; paired: { ready: boolean; fix: string }; udp: { ready: boolean; fix: string } } | null;
  id: string;
  name: string;
  state: string;
  klass: DigifabDeviceClass;
  enabled: boolean;
  tags: string[];
  linked_machine_id: string | null;
  /** The linked machine's own identity (name/photo/lifecycle state) — when
   *  present the tile wears it, so fleet and registry are one identity. */
  linked_machine?: { id: string; name: string; image_path: string | null; state: string | null; detail_url?: string | null } | null;
  pool_id: string | null;
  pool_name: string | null;
  /** Cockpit: live temps the manager reports (°C), if any. */
  temps: { nozzle?: DigifabDeviceTemp | null; bed?: DigifabDeviceTemp | null; chamber?: DigifabDeviceTemp | null; tools?: (DigifabDeviceTemp & { id: string; filament?: { material?: string; vendor?: string; color?: string } })[] } | null;
  /** Cockpit: current job sub-stage (preheating/leveling/…) when reported — the
   *  "why isn't it printing yet" signal. */
  stage: string | null;
  /** Cockpit: a webcam/MJPEG stream URL (manual override or driver-reported). */
  camera_url: string | null;
  /** Snapshot relay (opt-in, off by default) + whether a fresh relayed frame is
   *  available right now (the web prefers it over camera_url for remote viewing). */
  snapshot_relay: boolean;
  /** What an hour of this printer costs, when set; null otherwise. */
  hour_rate?: { amount: number; currency: string } | null;
  snapshot_fresh: boolean;
  /** The server answers this printer's frames on the cockpit /camera route (its
   *  bridge, the address saved or reported for it, or its manager's camera):
   *  every screen polls that route, never camera_url itself (#7056). */
  lan_camera?: boolean;
  /** Where /camera reads this machine's frames: the bridge, the address saved
   *  or reported for it, or the manager's own camera. */
  camera_source?: "bridge" | "address" | "manager" | null;
  /** AI failure-watch: live rolling score while printing + whether it auto-paused. */
  failure?: { score: number; watching: boolean; paused: boolean } | null;
  /** An external detector owns this printer's detection + camera — Cobblr stands
   *  down its own watch/assignment/camera pull for it. */
  managed_by_detector?: boolean;
  /** Lent out (record-loans.md): "Lent to Sam Lee.", and the farm sends it nothing. */
  lent?: string | null;
  /** F-1: finished/failed a print — needs a human bed-clear before it's assignable. */
  /** plate_qty: how many the plate's job makes, when it produces a build. */
  needs_attention: { reason: string; since: string; plate_qty?: number | null } | null;
  active_job: { id: string; file_ref: string; metadata?: Record<string, unknown>; status: string; progress: number | null; priority: number; attempts: number; max_attempts: number; eta_sec: number | null } | null;
  /** What this machine will do next — the top queued job aimed at it (or its pool). */
  next_job: { id: string; file_ref: string; metadata?: Record<string, unknown>; pooled: boolean } | null;
  /** Spatial floor-grid cell (arrange mode); null = unplaced. */
  position: { x: number; y: number } | null;
  /** Free-form layout: order in the flow (null = unplaced, trails in its own
   *  row) + whether this machine starts a new row. */
  sort_order?: number | null;
  row_break?: boolean;
  /** Real-time print telemetry from the printer itself (e.g. Bambu cloud MQTT) —
   *  for a print Cobblr didn't start, so there's no active_job to carry it. */
  live: { progress: number | null; remaining_min: number | null; layer_num: number | null; total_layers: number | null } | null;
}

export interface DigifabFleetConnection {
  bridge?: string | null;
  connection_id: string;
  label: string;
  type: string;
  error: string | null;
  /** When this connection's device list was last fetched from its manager (F-11
   *  cache); null when the connection errored. May be up to ~10s stale. */
  fetched_at: string | null;
  /** Served from the last-good cache while a live refresh runs server-side. */
  stale?: boolean;
  devices: DigifabFleetDevice[];
}

export interface DigifabFleet {
  /** Any connection served stale — a quick follow-up refetch will be fresher. */
  stale?: boolean;
  connections: DigifabFleetConnection[];
  summary: {
    devices: number;
    printing: number;
    idle: number;
    offline: number;
    error: number;
    connections: number;
    connections_down: number;
    needs_attention: number;
  };
}

export interface DigifabDevice {
  id: string;
  name: string;
  enabled: boolean;
  state?: string | null;
  tags?: string[];
}

export interface DigifabDriver {
  id: string;
  key: string;
  name: string;
  kind: string;
  spec: Record<string, unknown>;
  enabled: boolean;
  created_at: string;
}

/** What a slicer needs to know about a printer (Services §14.3). */
export interface PrintingProfile {
  /** A neutral printer model id, e.g. "bambulab/a1". */
  printer_model: string | null;
  nozzle_mm: number | null;
  /** [x, y, z] in mm. */
  build_volume_mm: [number, number, number] | null;
  default_quality: string | null;
  /** Filament type id -> preset to prefer for it on this printer. */
  preset_hints: Record<string, string>;
}

export interface DigifabLink {
  id: string;
  connection_id: string;
  remote_device_id: string;
  remote_device_name: string | null;
  machine_id: string;
  machine_label: string | null;
  created_at: string;
}

// Print-update rules — channels (destinations) + rules (scope→cadence→message).
export interface DigifabChannel {
  id: string;
  label: string;
  kind: string;
  enabled: boolean;
  created_at: string;
}
export type DigifabCadence = { type: "percent" | "minutes" | "layers"; every: number };
export type DigifabStep = { control: string; params?: Record<string, unknown> } | { wait_ms: number };
export interface DigifabRule {
  id: string;
  label: string;
  scope_type: "all" | "printer" | "tag" | "family";
  scope_value: string | null;
  channel_id: string;
  events: { started?: boolean; progress?: boolean; completed?: boolean; failed?: boolean };
  cadence: DigifabCadence[];
  cap_minutes: number | null;
  message: { title?: string; body?: string; photo?: boolean };
  pre_actions: DigifabStep[];
  post_actions: DigifabStep[];
  enabled: boolean;
  created_at: string;
}

export interface DigifabJobReview {
  materialSuggestion?: { material: string; thickness_mm: number } | null;
  thumbnailFileId?: string | null;
  sourceFile: { id: string; filename: string };
  fileId: string;
  projectHash: string;
  transport: "rest" | "udp" | "compiled";
  project: Record<string, unknown>;
  layers: Record<string, unknown>[];
  cuts: Record<string, unknown>[];
  materialLibrary: Record<string, unknown>;
}

export interface LaserMaterialTag { material: string; thickness_mm: number; width_mm: number; height_mm: number }
export interface ResinStockChoice { id: string; kind: string; name: string; shape: string; unit: string; remaining: number; used: number; revision: number; slot?: string; maintenance_due?: boolean; low?: boolean }
export interface MachineStationView {
  resin?: { station: string; loaded: ResinStockChoice[]; canStart: boolean; warning: string; stockError: string | null; postprocess: Array<{ job_id: string; file_ref: string; metadata?: Record<string, unknown>; wash_done: boolean; cure_done: boolean }> };
  kind?: string | null;
  screen_kind?: "laser" | "print" | "cnc" | "cutter" | "resin" | "large-format" | "bench" | "production-test" | null;
  machine_id?:string|null;
  job: (DigifabJob & { sent_at?: string | null }) | null;
  library: DigifabLibraryItem | null;
  attention: { job_id: string | null; reason: string } | null;
  sheets: Array<{ id: string; name: string; material: LaserMaterialTag | null }>;
  cncStock?: import("@cobblr/platform-contract/cnc").CncStationStock[];
}

export interface DigifabJob {
  material_pending?: boolean;
  embroidery_run?: boolean;
  id: string;
  /** Custom fields a bundle or a person defines for this kind. */
  metadata?: Record<string, unknown>;
  connection_id: string | null;
  file_ref: string;
  target_device: string | null;
  target_tag: string | null;
  target_pool: string | null;
  material_part_id: string | null;
  material_grams: string | null;
  remote_file_id: string | null;
  remote_job_id: string | null;
  status: string;
  priority: number;
  attempts: number;
  max_attempts: number;
  progress: number | null;
  error: string | null;
  file_id: string | null;
  linked_machine_id: string | null;
  linked_task_id: string | null;
  /** A build (BoM) this job produces — components consumed from inventory on
   *  send, the output counted when the plate is judged good; reversed on
   *  scrap/cancel/fail. */
  linked_build_id: string | null;
  build_qty: number;
  build_consumed_at: string | null;
  build_reversed_at: string | null;
  /** How the plate came out, once judged: good (some came out good) or scrap,
   *  with how many of each. Null until the verdict. */
  outcome?: "good" | "scrap" | null;
  outcome_good_qty?: number | null;
  outcome_scrap_qty?: number | null;
  created_at: string;
  updated_at: string;
  last_polled_at: string | null;
  /** True for a print started ON the machine (observed), not sent via Cobblr —
   *  read-only in the queue (no send/delete). */
  external?: boolean;
}

export interface DigifabPoolMember {
  connection_id: string;
  remote_device_id: string;
  loaded_material: string | null;
}

/** A Make's steps, in the one order they run. */
export const MAKE_STEPS = ["request", "design", "model", "slice", "print", "outcome"] as const;
export type MakeStepName = (typeof MAKE_STEPS)[number];
export type MakeFileRole = "source" | "step" | "stl" | "3mf" | "preview" | "report" | "gcode" | "settings" | "snapshot" | "photo" | "other";

export interface MakePrintBatch {
  quantity: number;
  completed: number;
  state: "review" | "running" | "waiting_bed" | "changed" | "needs_approval" | "complete" | "cancelled" | "failed";
  review_hash: string;
  facts: Record<string, unknown>;
  approvals: Array<{ hash: string; by: string; at: string }>;
  starts: Array<{ job_id: string; ordinal: number; approval: string; by: string; at: string; status: string }>;
  settled: Array<{ job_id: string; ordinal: number; status: string }>;
}
export interface MakePrintBatchSummary {
  id: string; make_id: string; name: string; linked_machine_id: string | null;
  status: MakeStepRecord["status"]; data: Record<string, unknown>; error: string | null;
}
export interface MakeSummary {
  id: string;
  /** Custom fields a bundle or a person defines for this kind. */
  metadata?: Record<string, unknown>;
  name: string;
  prompt: string | null;
  start_step: MakeStepName;
  rerun_of: string | null;
  rerun_from_step: MakeStepName | null;
  folder_id: string | null;
  printer_name: string | null;
  material: string | null;
  outcome: "pass" | "fail" | null;
  created_at: string;
  updated_at: string;
  last_step?: { step: MakeStepName; status: string } | null;
}

export interface MakeStepRecord {
  id: string;
  step: MakeStepName;
  status: "running" | "needs_input" | "awaiting_confirm" | "done" | "failed";
  data: Record<string, unknown>;
  produced_by: { kind?: string; name?: string; version?: string; capability?: string };
  service_job_id: string | null;
  job_id: string | null;
  error: string | null;
  copied_from: string | null;
  created_at: string;
  updated_at: string;
  files: Array<{ id: string; file_id: string; role: MakeFileRole | null; filename: string; mime_type: string; kind: string }>;
}

export interface MakeDoor {
  label: string;
  href?: string;
  action?: "upload-model" | "upload-gcode" | "rerun" | "outcome";
}

/** What Print this answers once it has a printer and a slice going. */
export interface PrintThisStarted {
  ok: true;
  make_id: string;
  created_make: boolean;
  printer: { machine: string | null; reason: string };
  slice_job_id: string | null;
  summary: string;
}

export interface MakeDetail {
  make: MakeSummary;
  steps: MakeStepRecord[];
  timeline: {
    entries: Array<{ step: MakeStepName; state: "recorded"; row: MakeStepRecord } | { step: MakeStepName; state: "waiting"; hint: string }>;
    end: null | { step: MakeStepName; reason: "not-connected" | "failed"; sentence: string; doors: MakeDoor[] };
  };
  reach: { design: boolean; slice: boolean; print: boolean };
  print: null | {
    job_id: string;
    status: string;
    progress: number | null;
    file_ref: string;
    error: string | null;
    machine: { id: string; title: string | null; detail_url: string | null } | null;
    spools: Array<{ part_id: string; grams: number; slot: string | null; title: string | null }>;
    material_pending?: boolean;
    grams_measured: boolean;
    grams_by_tool: number[] | null;
  };
  rerun_of: { id: string; name: string } | null;
  /** What it was made for (an order line, a work order), when something asked for it. */
  made_for: { kind: string; id: string; title: string | null; detail_url: string | null } | null;
  reruns: Array<{ id: string; name: string; rerun_from_step: MakeStepName | null; outcome: "pass" | "fail" | null; created_at: string }>;
}

export type MakeCreateBody =
  | { name: string; prompt: string; origin?: "page" }
  | { name: string; start_at: "model" | "slice"; files: Array<{ file_id: string; role: MakeFileRole }> }
  | { name: string; rerun_of: string; from_step: "design" | "model" | "slice" | "print" };

export interface DigifabRun {
  laser_plan_id?: string | null;
  id: string;
  name: string;
  pool_id: string;
  file_id: string | null;
  file_ref: string;
  parts_per_plate: number;
  target_qty: number;
  completed_qty: number;
  status: "active" | "paused" | "completed" | "cancelled";
  jobs_queued: number;
  jobs_printing: number;
  jobs_awaiting_verdict: number;
  jobs_scrapped: number;
  created_at: string;
  updated_at: string;
}

export interface DigifabPool {
  id: string;
  name: string;
  config: Record<string, unknown>;
  members: DigifabPoolMember[];
}

export interface LaserProfile { operation: "cut" | "score" | "engrave"; material: string; thickness_mm: number; speed: number; min_power: number; max_power: number; passes: number; air_assist: boolean; focus_offset: number }
export interface LaserProfileRecord { id: string; profile: LaserProfile; source: { library?: string; guid?: string; imported_at?: string; edited_at?: string }; connection_id: string; remote_device_id: string }
export interface LaserRect { x: number; y: number; width: number; height: number }
export interface LaserPoint { x: number; y: number; c0?: { x: number; y: number }; c1?: { x: number; y: number } }
export interface LaserDesign { width: number; height: number; paths: Array<{ layer: string; points: LaserPoint[]; closed: boolean; curves?: boolean[] }> }
export interface LaserPlacement extends LaserRect { locked?: boolean; mirrored?: boolean; design?: LaserDesign; extra?: boolean; number: number; rotated: boolean; footprint: LaserRect; angle?: number; translation?: { x: number; y: number }; footprint_outline?: Array<{ x: number; y: number }> }
export interface LaserLayoutSheet { id: string; name?: string; width: number; height: number; revision: number; free_rectangles: LaserRect[]; parts: LaserPlacement[]; remaining: LaserRect[]; svg?: string; nesting?: "outline" | "rectangle"; nesting_note?: string; nest_ms?: number; utilisation?: number; used_outlines?: Array<Array<{ x: number; y: number }>> }
export interface LaserPlanRecord { id: string; connection_id: string; remote_device_id: string; run_id: string | null; plan: { name: string; quantity: number; material: string; thickness_mm: number; estimated_sec: number; design: LaserDesign; sheets: LaserLayoutSheet[]; adjustments?: LaserLayoutAdjustments } }
export interface LaserJobLayout { plan_id: string; sheet_id: string; quantity: number; design: LaserDesign; parts: LaserPlacement[]; footprints: LaserRect[]; expected?: Array<LaserProfileRecord["profile"] & { index: number; layer: string }> }

export interface MaterialDispatch { id: string; library_id: string; status: string; error: string | null; plan_ids: string[]; request: { quantity: number; material: string; thickness_mm: number } }
export interface FabricationFloor {
 jobs: Array<{ id: string; connection_id: string | null; target_device: string | null; target_pool: string | null; file_ref: string; metadata?: Record<string, unknown>; status: string; progress: number | null; eta_sec: number | null; blocked: string | null }>;
 batches: MaterialDispatch[]; layouts: LaserPlanRecord[];
 reorders: Array<{ key: string; text: string; link: string }>;
 stock: Array<{ material: string; thickness_mm: number | null; sheets: number; offcuts: number; free_mm2: number; spools: number; grams: number }>;
 stock_complete: boolean; drawings: Array<{ id: string; name: string; kind: string }>;
 pools: Array<{ id: string; name: string }>; members: Array<{ pool_id: string; connection_id: string; remote_device_id: string }>;
 laser_materials: Array<{ material: string; thickness_mm: number }>;
 laser_devices: Array<{ connection_id: string; device_id: string }>;
}

export interface BenchCapture {channels:string[];samplerate:number;duration_ms:number;trigger?:string;decoder?:"uart"|"i2c"|"spi"|"can"|"onewire_link";decoder_options?:Record<string,string>;data_b64?:string}
export interface BenchOperation {machine_id:string;operation:"identify"|"read"|"log"|"output_off"|"capture"|"configure"|"output_on"|"set_voltage"|"set_current";record_kind?:string;record_id?:string;capture?:BenchCapture;confirmed?:boolean;control_enabled?:boolean;value?:number}
export interface BenchReport {identity:string;profile:string;at:string;protection?:string;output_enabled?:boolean;capture?:{data_b64?:string;decoded:string};readings:{quantity:string;value:number;unit:string}[];screenshot?:{mime_type:"image/bmp";data_b64:string}}
export interface BenchReading {id:string;machine_id:string;record_kind:string;record_id:string;report:BenchReport;screenshot_file_id:string|null;capture_file_id:string|null}
export interface BenchPage {items:BenchReading[];total:number;connection_error:string|null;instrument:{connection_id:string;device_id:string;name:string;profile:string;identity:string;output_off:boolean;control_enabled?:boolean}|null}
export interface CutterProfileRecord {id:string;profile:CutterProfile;connection_id:string;remote_device_id:string}
export interface CutterRollView {id:string;name:string;kind:string;instance:string;remaining:number;revision:number;config:{width_mm:number;waste:number}}
export interface CutterStationView {
 plan:{id:string;job_id:string;started_at:string|null;report:{verdict:"good"|"scrap";used_length_m:number}|null;plan:{program:CutterProgram;roll:CutterRollView;quantity:number;used_length_m:number;content_hash:string}}|null;
 job:DigifabJob|null;attention:{job_id:string|null;reason:string}|null;
 stock:{items:CutterRollView[];loaded:Array<{part_id:string;station:string;slot:string}>};station_key:string;
}

export interface LargeFormatHistory {
 job_id:string;file_ref:string;status:string;created_at:string;consumed_at:string|null;
 plan:{ink_stock:Array<{id:string;kind:string;name:string;slot:string}>;filename:string;width_mm:number;height_mm:number;pages:number;copies:number;margin_mm:number;media_type:string;used_length_m:number;roll:{id:string;name:string}};
 report:{verdict:"good"|"scrap";used_length_m:number;ink:Array<{stock_id:string;amount_ml:number;estimated:boolean}>}|null;
}
export interface LargeFormatView {
 station:string;plan:LargeFormatHistory|null;job:DigifabJob|null;
 supplies:Array<{supply_id:string;low:boolean;updated_at:string;reading:{name:string;percent:number|null;remaining_ml:number|null}}>;
}

export interface LaserLayoutAlternative { goal: "most_parts" | "fewest_sheets" | "shortest_time"; seed: number; sheets: LaserLayoutSheet[]; utilisation: number; estimated_sec: number }
export interface LaserLayoutAdjustments { sheets: LaserLayoutSheet[]; spacing_mm: number; kerf_mm: number; rotate: boolean; rotation_step: number; allow_flip: boolean; seed: number; avoid: Record<string,LaserRect[]>; limits: Record<string,number>; alternatives: LaserLayoutAlternative[]; selected: number; revision: number }
export type LaserLayoutAdjustment =
 | {operation:"pick";alternative:number}
 | {operation:"lock";parts:number[];locked:boolean}
 | {operation:"clear_locks"}
 | {operation:"avoid";sheet_id:string;rectangle:LaserRect;permanent?:boolean}
 | {operation:"clear_avoid";sheet_id:string}
 | {operation:"renest";budget_ms?:number}
 | {operation:"move"|"check_move";part:number;sheet_id:string;x:number;y:number;angle?:number;mirrored?:boolean}
 | {operation:"limit";sheet_id:string;maximum:number}
 | {operation:"fill";sheet_id:string}
 | {operation:"export";sheet_id:string;format:"svg"|"dxf"|"lightburn"}
 | {operation:"import";sheet_id:string;filename:string;content:string;extras?:"review"|"keep"|"drop";assignments?:Record<string,number>};

export const digifabApi = {
  embroideryList: <T>(slug:string,path:string) => request<T>("GET",`/orgs/${slug}/modules/digifab/embroidery/${path}`),
  /** Whether this browser's station credential is authorized for the machine; refused (403) to someone who may not run jobs at a station. */
  embroideryStationCheck: (slug:string, machineId:string, body:{station_id:string;token:string}) => request<{authorized:boolean}>("POST",`/orgs/${slug}/modules/digifab/embroidery/machines/${machineId}/stations/check`, body),
  enrollEmbroideryStation: (slug:string,id:string,label:string) => request<{id:string;label:string;token:string}>("POST",`/orgs/${slug}/modules/digifab/embroidery/machines/${id}/stations`,{label}),
  revokeEmbroideryStation: (slug:string,id:string,stationId:string) => request<{ok:true}>("DELETE",`/orgs/${slug}/modules/digifab/embroidery/machines/${id}/stations/${stationId}`),
  downloadEmbroidery: async(slug:string,id:string):Promise<Blob> => {
    const headers:Record<string,string>={},token=getToken(),imp=getImpersonationToken();if(token)headers.Authorization=`Bearer ${token}`;if(imp)headers["X-Impersonation"]=imp;
    const res=await fetch(`/api/v1/orgs/${slug}/modules/digifab/embroidery/runs/${id}/export`,{headers});
    if(!res.ok)throw new ApiError(res.status,"embroidery_export_failed","This prepared embroidery file could not be downloaded.");return res.blob();
  },

  // ─── digifab (print-farm connections) ──────────────────────────
  listDigifabConnections: (slug: string) =>
    request<{ items: DigifabConnection[]; types: string[] }>(
      "GET",
      `/orgs/${slug}/modules/digifab/connections`,
    ),
  discoverBenchESPHome:(slug:string,bridge:string|null)=>request<{items:{name:string;host:string;port:number}[]}>("GET",`/orgs/${slug}/modules/digifab/bench/discover${bridge?`?bridge=${encodeURIComponent(bridge)}`:""}`),
  discoverSnapmakers: (slug: string, bridge: string | null) => request<{ items: { name: string; host: string; model: string; transport: "http" | "sacp" }[] }>("GET", `/orgs/${slug}/modules/digifab/snapmaker/discover${bridge ? `?bridge=${encodeURIComponent(bridge)}` : ""}`),
  pairSnapmaker: (slug: string, connectionId: string) => request<{ state: "waiting" | "paired" }>("POST", `/orgs/${slug}/modules/digifab/snapmaker/${connectionId}/pair`, {}),
  // The live fleet/floor view: every enabled connection's devices + state, with
  // Cobblr's in-flight jobs overlaid. Read-only; the page polls it.
  getFabricationFloor: (slug: string) => request<FabricationFloor>("GET", `/orgs/${slug}/modules/digifab/floor`),
  getDigifabFleet: (slug: string) =>
    request<DigifabFleet>("GET", `/orgs/${slug}/modules/digifab/fleet`),
  // F-1: clear a printer's bed-clear flag — "cleared, ready for the next job".
  // F-13 — clear the bed + give the verdict. "good" closes the linked task;
  // "scrapped" reverses the optimistic filament/usage effects. Default "good".
  // With counts, the plate is judged part by part ("9 good, 1 scrap") and the
  // counts decide the outcome; without them it is the whole plate.
  markDigifabDeviceReady: (
    slug: string,
    connectionId: string,
    deviceId: string,
    outcome: "good" | "scrapped" = "good",
    counts?: { good: number; scrap: number },
    machine?: { jobId: string; toolSeconds?: Record<string, number> },
  ) =>
    request<{ ok: boolean; outcome: string }>(
      "POST",
      `/orgs/${slug}/modules/digifab/fleet/${connectionId}/${encodeURIComponent(deviceId)}/ready`,
      { outcome, ...(counts ? { good: counts.good, scrap: counts.scrap } : {}), ...(machine ? { job_id: machine.jobId, tool_seconds: machine.toolSeconds } : {}) },
    ),
  // Cockpit: set/clear a device's camera stream URL (manual override).
  setDigifabDevicePosition: (slug: string, connId: string, deviceId: string, pos: { x: number; y: number } | null) =>
    request<{ ok: boolean }>("PUT", `/orgs/${slug}/modules/digifab/fleet/${connId}/${encodeURIComponent(deviceId)}/position`, pos ?? { x: null, y: null }),
  saveDigifabFleetLayout: (slug: string, items: Array<{ connection_id: string; device_id: string; row_break?: boolean }>) =>
    request<{ ok: boolean; placed: number }>("PUT", `/orgs/${slug}/modules/digifab/fleet/layout`, { items }),
  setDigifabDeviceCamera: (slug: string, connectionId: string, deviceId: string, cameraUrl: string | null) =>
    request<{ ok: boolean; camera_url: string | null }>("POST", `/orgs/${slug}/modules/digifab/fleet/${connectionId}/${encodeURIComponent(deviceId)}/camera`, { camera_url: cameraUrl }),
  // Snapshot relay (opt-in, off by default): toggle whether the cloud accepts +
  // serves agent-pushed frames for remote viewing.
  setDigifabDeviceSnapshotRelay: (slug: string, connectionId: string, deviceId: string, enabled: boolean) =>
    request<{ ok: boolean; snapshot_relay: boolean }>("POST", `/orgs/${slug}/modules/digifab/fleet/${connectionId}/${encodeURIComponent(deviceId)}/snapshot-relay`, { enabled }),
  /** The spools loaded on a printer, by slot (digifab loaded.ts). */
  digifabLoaded: (slug: string, machineId: string) =>
    request<DigifabLoaded>("GET", `/orgs/${slug}/modules/digifab/loaded/${encodeURIComponent(machineId)}`),
  digifabSetSlots: (slug: string, machineId: string, slots: number) =>
    request<DigifabLoaded>("PUT", `/orgs/${slug}/modules/digifab/loaded/${encodeURIComponent(machineId)}/slots`, { slots }),
  /** Load a spool (into `slot`, else the first empty one). The one it
   *  replaces goes back to its shelf and comes back in `returned`. */
  digifabLoad: (slug: string, machineId: string, partId: string, slot?: string) =>
    request<DigifabLoaded & { slot: string; returned: Array<{ thing: { id: string; title?: string }; to: { id: string; title?: string } | null }> }>(
      "POST",
      `/orgs/${slug}/modules/digifab/loaded/${encodeURIComponent(machineId)}/load`,
      { part_id: partId, ...(slot ? { slot } : {}) },
    ),
  digifabUnload: (slug: string, machineId: string, slot: string) =>
    request<DigifabLoaded & { to: { id: string; title?: string } | null }>("POST", `/orgs/${slug}/modules/digifab/loaded/${encodeURIComponent(machineId)}/unload`, { slot }),
  digifabSnapshotPath: (slug: string, connectionId: string, deviceId: string) =>
    `/orgs/${slug}/modules/digifab/fleet/${connectionId}/${encodeURIComponent(deviceId)}/snapshot`,
  createDigifabConnection: (
    slug: string,
    body: {
      type: string;
      label: string;
      base_url: string;
      api_key?: string;
      username?: string;
      password?: string;
      /** Edge machine config (driver + host + key) — stored encrypted, ridden down
       *  the tunnel so a dynamic-config bridge configures the driver on the fly. */
      config?: Record<string, unknown>;
    },
  ) => request<DigifabConnection>("POST", `/orgs/${slug}/modules/digifab/connections`, body),
  // ── Bambu Lab cloud-login connect wizard ──────────────────────────────────
  bambuLogin: (slug: string, body: { region: string; email: string; password: string }) =>
    request<BambuLoginResponse>("POST", `/orgs/${slug}/modules/digifab/bambu/login`, body),
  bambuCode: (slug: string, body: { session: string; code: string }) =>
    request<BambuLoginResponse>("POST", `/orgs/${slug}/modules/digifab/bambu/code`, body),
  bambuCreate: (slug: string, body: { session: string; mode: BambuMode; label?: string }) =>
    request<{ connection: DigifabConnection; devices: BambuDiscoveredDevice[]; capabilities: BambuModeCapabilities }>(
      "POST",
      `/orgs/${slug}/modules/digifab/bambu/create`,
      body,
    ),
  getBambuCapabilities: (slug: string) =>
    request<{ modes: Record<BambuMode, BambuModeCapabilities> }>("GET", `/orgs/${slug}/modules/digifab/bambu/capabilities`),
  sendBambuCommand: (slug: string, body: { connection_id: string; serial: string; command: "pause" | "resume" | "stop" | "light_on" | "light_off" | "nudge" }) =>
    request<{ sent: boolean }>("POST", `/orgs/${slug}/modules/digifab/bambu/command`, body),
  // ── Generic live controls (driver-declared) ───────────────────────────────
  getDigifabControls: (slug: string, connId: string, deviceId: string) =>
    request<{ controls: DigifabControl[] }>("GET", `/orgs/${slug}/modules/digifab/fleet/${connId}/${encodeURIComponent(deviceId)}/controls`),
  getDigifabFiles: (slug: string, connId: string, deviceId: string, refresh = false) =>
    request<{ files: { name: string; size?: number; modified?: string }[]; cached: boolean; stale?: boolean; error?: string | null; at: string }>(
      "GET",
      `/orgs/${slug}/modules/digifab/fleet/${connId}/${encodeURIComponent(deviceId)}/files${refresh ? "?refresh=1" : ""}`,
    ),
  printDigifabFile: (slug: string, connId: string, deviceId: string, name: string) =>
    request<{ ok: boolean; ref?: string }>("POST", `/orgs/${slug}/modules/digifab/fleet/${connId}/${encodeURIComponent(deviceId)}/print`, { name }),
  getDigifabFileInfo: (slug: string, connId: string, deviceId: string, name: string) =>
    request<{ info: DigifabFileInfo | null; cached: boolean; stale?: boolean }>(
      "GET",
      `/orgs/${slug}/modules/digifab/fleet/${connId}/${encodeURIComponent(deviceId)}/fileinfo?name=${encodeURIComponent(name)}`,
    ),
  getDigifabDeviceDetail: (slug: string, connId: string, deviceId: string) =>
    request<DigifabDeviceDetail>("GET", `/orgs/${slug}/modules/digifab/fleet/${connId}/${encodeURIComponent(deviceId)}/detail`),
  // NB: a PATH (no /api/v1) — fetchAuthBlobUrl prepends /api/v1. Including it here
  // double-prefixed the URL → /api/v1/api/v1/… → 404 (the "camera not reachable" bug).
  digifabCameraPath: (slug: string, connId: string, deviceId: string) =>
    `/orgs/${slug}/modules/digifab/fleet/${connId}/${encodeURIComponent(deviceId)}/camera`,
  setBambuLan: (slug: string, connId: string, deviceId: string, body: { host?: string; access_code?: string; mode?: "cloud" | "prefer_lan" | "lan_only" }) =>
    request<{ ok: boolean; host: string; mode: string }>("PUT", `/orgs/${slug}/modules/digifab/fleet/${connId}/${encodeURIComponent(deviceId)}/lan`, body),
  clearBambuLan: (slug: string, connId: string, deviceId: string) =>
    request<{ ok: boolean }>("DELETE", `/orgs/${slug}/modules/digifab/fleet/${connId}/${encodeURIComponent(deviceId)}/lan`),
  // ── Print-update rules: channels (destinations) + rules ──
  listDigifabChannels: (slug: string) =>
    request<{ items: DigifabChannel[] }>("GET", `/orgs/${slug}/modules/digifab/print-rules/channels`),
  createDigifabChannel: (slug: string, body: { label: string; webhook_url: string }) =>
    request<DigifabChannel>("POST", `/orgs/${slug}/modules/digifab/print-rules/channels`, body),
  patchDigifabChannel: (slug: string, id: string, body: { label?: string; webhook_url?: string; enabled?: boolean }) =>
    request<DigifabChannel>("PATCH", `/orgs/${slug}/modules/digifab/print-rules/channels/${id}`, body),
  deleteDigifabChannel: (slug: string, id: string) =>
    request<void>("DELETE", `/orgs/${slug}/modules/digifab/print-rules/channels/${id}`),
  testDigifabChannel: (slug: string, id: string) =>
    request<{ ok: boolean }>("POST", `/orgs/${slug}/modules/digifab/print-rules/channels/${id}/test`, {}),
  listDigifabRules: (slug: string) =>
    request<{ items: DigifabRule[] }>("GET", `/orgs/${slug}/modules/digifab/print-rules/rules`),
  createDigifabRule: (slug: string, body: Partial<Omit<DigifabRule, "id" | "created_at">>) =>
    request<DigifabRule>("POST", `/orgs/${slug}/modules/digifab/print-rules/rules`, body),
  patchDigifabRule: (slug: string, id: string, body: Partial<Omit<DigifabRule, "id" | "created_at">>) =>
    request<DigifabRule>("PATCH", `/orgs/${slug}/modules/digifab/print-rules/rules/${id}`, body),
  deleteDigifabRule: (slug: string, id: string) =>
    request<void>("DELETE", `/orgs/${slug}/modules/digifab/print-rules/rules/${id}`),
  previewDigifabRule: (slug: string, body: { title?: string; body?: string }) =>
    request<{ title: string; body: string }>("POST", `/orgs/${slug}/modules/digifab/print-rules/preview`, body),
  testFireDigifabRule: (slug: string, body: { channel_id: string; message?: { title?: string; body?: string; photo?: boolean }; scope_type?: string; scope_value?: string | null; pre_actions?: DigifabStep[]; post_actions?: DigifabStep[] }) =>
    request<{ ok: boolean; printer: string }>("POST", `/orgs/${slug}/modules/digifab/print-rules/test-fire`, body),
  runDigifabControl: (slug: string, connId: string, deviceId: string, id: string, params?: Record<string, unknown>) =>
    request<{ ok: boolean; ref?: string }>("POST", `/orgs/${slug}/modules/digifab/fleet/${connId}/${encodeURIComponent(deviceId)}/control`, { id, params }),
  testDigifabConnection: (slug: string, id: string) =>
    request<{ ok: boolean; detail?: string; capabilities: { routing: boolean } }>(
      "POST",
      `/orgs/${slug}/modules/digifab/connections/${id}/test`,
      {},
    ),
  listDigifabDevices: (slug: string, id: string) =>
    request<{ items: DigifabDevice[] }>(
      "GET",
      `/orgs/${slug}/modules/digifab/connections/${id}/printers`,
    ),
  updateDigifabConnection: (
    slug: string,
    id: string,
    body: { label?: string; base_url?: string; enabled?: boolean; api_key?: string | null; username?: string | null; password?: string | null; config?: Record<string, unknown> },
  ) => request<DigifabConnection>("PATCH", `/orgs/${slug}/modules/digifab/connections/${id}`, body),
  deleteDigifabConnection: (slug: string, id: string) =>
    request<void>("DELETE", `/orgs/${slug}/modules/digifab/connections/${id}`),
  // Edge tunnel: is an on-site bridge currently dialed in for this workspace?
  // ── Edge-bridge machine sharing (owner side) ──────────────────────────────
  listEdgeShares: (slug: string) =>
    request<{ items: EdgeShare[] }>("GET", `/orgs/${slug}/modules/digifab/edge-shares`),
  createEdgeShare: (slug: string, body: { label: string; scope: "read" | "write"; instance_ids: string[]; expires_in_days?: number }) =>
    request<{ id: string; token: string; owner_org: string; scope: string; machine_count: number; expires_at: string | null }>(
      "POST",
      `/orgs/${slug}/modules/digifab/edge-shares`,
      body,
    ),
  redeemEdgeShare: (slug: string, body: { owner_org: string; token: string }) =>
    request<{ scope: string; machines: { id: string; label: string }[]; already?: boolean }>(
      "POST",
      `/orgs/${slug}/modules/digifab/edge-shares/redeem`,
      body,
    ),
  revokeEdgeShare: (slug: string, id: string) =>
    request<{ ok: boolean }>("POST", `/orgs/${slug}/modules/digifab/edge-shares/${id}/revoke`, {}),
  getDigifabHistory: (slug: string, days = 30) =>
    request<DigifabHistory>("GET", `/orgs/${slug}/modules/digifab/history?days=${days}`),
  // ── AI print-failure detection ────────────────────────────────────────────
  getDigifabFailureConfig: (slug: string) =>
    request<DigifabFailureConfig>("GET", `/orgs/${slug}/modules/digifab/failure/config`),
  setDigifabFailureConfig: (slug: string, patch: Partial<DigifabFailureConfig>) =>
    request<DigifabFailureConfig>("PUT", `/orgs/${slug}/modules/digifab/failure/config`, patch),
  getDigifabFailureStatus: (slug: string, connId: string, deviceId: string) =>
    request<DigifabFailureStatus>("GET", `/orgs/${slug}/modules/digifab/failure/${connId}/${encodeURIComponent(deviceId)}/status`),
  checkDigifabFailure: (slug: string, connId: string, deviceId: string) =>
    request<DigifabFailureCheck>("POST", `/orgs/${slug}/modules/digifab/failure/${connId}/${encodeURIComponent(deviceId)}/check`, {}),
  // ── External detectors (Obico ML API, PrintGuard, generic LAN box) ─────────
  getDigifabDetectorCatalog: (slug: string) =>
    request<{ detectors: DigifabDetectorCatalogEntry[] }>("GET", `/orgs/${slug}/modules/digifab/failure/detectors/catalog`),
  listDigifabDetectors: (slug: string) =>
    request<{ detectors: DigifabDetector[] }>("GET", `/orgs/${slug}/modules/digifab/failure/detectors`),
  createDigifabDetector: (slug: string, body: DigifabDetectorInput) =>
    request<DigifabDetector>("POST", `/orgs/${slug}/modules/digifab/failure/detectors`, body),
  updateDigifabDetector: (slug: string, id: string, body: Partial<DigifabDetectorInput>) =>
    request<DigifabDetector>("PATCH", `/orgs/${slug}/modules/digifab/failure/detectors/${id}`, body),
  deleteDigifabDetector: (slug: string, id: string) =>
    request<{ ok: boolean }>("DELETE", `/orgs/${slug}/modules/digifab/failure/detectors/${id}`),
  testDigifabDetector: (slug: string, id: string) =>
    request<{ ok: boolean; detail?: string; version?: string | null; compatible?: boolean }>("POST", `/orgs/${slug}/modules/digifab/failure/detectors/${id}/test`, {}),
  listDigifabDetectorCameras: (slug: string, id: string) =>
    request<{ cameras: DigifabDetectorCamera[] }>("GET", `/orgs/${slug}/modules/digifab/failure/detectors/${id}/cameras`),
  getDigifabDetectorProviders: (slug: string, id: string) =>
    request<{ providers: DigifabDetectorProvider[]; mappings: DigifabDetectorMapping[] }>("GET", `/orgs/${slug}/modules/digifab/failure/detectors/${id}/providers`),
  listDigifabDetectorPrinters: (slug: string, id: string) =>
    request<{ printers: DigifabDetectorPrinter[] }>("GET", `/orgs/${slug}/modules/digifab/failure/detectors/${id}/printers`),
  registerDigifabDetectorPrinter: (slug: string, id: string, body: { name: string; provider: string; config: Record<string, unknown>; watch?: boolean }) =>
    request<{ ok: boolean; printer_id: string | null; camera_id: string | null; monitor: boolean }>("POST", `/orgs/${slug}/modules/digifab/failure/detectors/${id}/printers`, body),
  mirrorDigifabDetectorPrinter: (slug: string, id: string, body: { connection_id: string; device_id?: string; name?: string; watch?: boolean; disable_source?: boolean }) =>
    request<{ ok: boolean; printer_id: string | null; camera_id: string | null; monitor: boolean; source_disabled?: boolean }>("POST", `/orgs/${slug}/modules/digifab/failure/detectors/${id}/printers/from-connection`, body),
  savedLaserPlans: (slug: string, libraryId: string, offset = 0) => request<{ items: LaserPlanRecord[]; total: number | null; complete: boolean }>("GET", `/orgs/${slug}/modules/digifab/laser/plans?library_id=${encodeURIComponent(libraryId)}&limit=20&offset=${offset}`),
  laserProfiles: (slug: string, connectionId: string, deviceId: string) => request<{ items: LaserProfileRecord[] }>("GET", `/orgs/${slug}/modules/digifab/laser/profiles?${new URLSearchParams({ connection_id: connectionId, device_id: deviceId })}`),
  importLaserProfiles: (slug: string, connectionId: string, deviceId: string) => request<{ items: LaserProfileRecord[] }>("POST", `/orgs/${slug}/modules/digifab/laser/profiles/import`, { connection_id: connectionId, device_id: deviceId }),
  createLaserProfile: (slug: string, connectionId: string, deviceId: string, profile: LaserProfile) => request<LaserProfileRecord>("POST", `/orgs/${slug}/modules/digifab/laser/profiles`, { connection_id: connectionId, device_id: deviceId, profile }),
  saveLaserProfile: (slug: string, id: string, profile: LaserProfile) => request<LaserProfileRecord>("PUT", `/orgs/${slug}/modules/digifab/laser/profiles/${id}`, profile),
  laserDesign: (slug: string, id: string, units: string) => request<LaserDesign>("GET", `/orgs/${slug}/modules/digifab/laser/design/${id}?units=${units}`),
  nestDrawing: (slug: string, body: { library_id: string; quantity: number; sheet_ids: string[]; spacing_mm: number; kerf_mm: number; rotate: boolean; dxf_units: string; rotation_step?: number; budget_ms?: number }) => request<{ design: LaserDesign; sheets: LaserLayoutSheet[]; quantity: number }>("POST", `/orgs/${slug}/modules/digifab/laser/nest`, body),
  adjustLaserPlan: (slug: string, id: string, body: LaserLayoutAdjustment) => request<LaserPlanRecord | {valid: true} | {filename: string; content: string} | {unmatched: string[]; missing?: number[]}>("POST", `/orgs/${slug}/modules/digifab/laser/plans/${id}/adjust`, body),
  createLaserPlan: (slug: string, body: { connection_id: string; device_id: string; library_id: string; quantity: number; sheet_ids: string[]; mapping: Record<string, string>; spacing_mm: number; kerf_mm: number; rotate: boolean; dxf_units: string; rotation_step?: number; budget_ms?: number; seed?: number; allow_flip?: boolean }) => request<LaserPlanRecord>("POST", `/orgs/${slug}/modules/digifab/laser/plans`, body),
  acceptLaserPlan: (slug: string, id: string) => request<{ run_id: string; jobs: string[] }>("POST", `/orgs/${slug}/modules/digifab/laser/plans/${id}/accept`, {}),
  discardLaserPlan: (slug: string, id: string) => request<{ ok: boolean }>("DELETE", `/orgs/${slug}/modules/digifab/laser/plans/${id}`),
  // ── File library (stored 3MF/gcode + send-to-machine) ─────────────────────
  listDigifabLibrary: (slug: string) =>
    request<{ items: DigifabLibraryItem[] }>("GET", `/orgs/${slug}/modules/digifab/library`),
  uploadDigifabLibrary: async (slug: string, file: File, name?: string): Promise<DigifabLibraryItem> => {
    const form = new FormData();
    form.set("file", file);
    if (name) form.set("name", name);
    return upload<DigifabLibraryItem>(`/api/v1/orgs/${slug}/modules/digifab/library`, form, file);
  },
  renameDigifabLibrary: (slug: string, id: string, body: { name?: string; notes?: string | null; laser_material?: LaserMaterialTag }) =>
    request<DigifabLibraryItem>("PATCH", `/orgs/${slug}/modules/digifab/library/${id}`, body),
  deleteDigifabLibrary: (slug: string, id: string) =>
    request<{ ok: boolean }>("DELETE", `/orgs/${slug}/modules/digifab/library/${id}`),
  sendDigifabLibrary: (slug: string, id: string, body: { connection_id?: string; target_device?: string | null; target_pool?: string | null }) =>
    request<{ job_id: string; status: string }>("POST", `/orgs/${slug}/modules/digifab/library/${id}/send`, body),
  listDigifabDrivers: (slug: string) =>
    request<{ builtins: { key: string; name: string; kind: string }[]; installed: DigifabDriver[] }>(
      "GET",
      `/orgs/${slug}/modules/digifab/drivers`,
    ),
  // The "app store" shelf: ready-to-install firmware drivers that ship with
  // digifab (Duet/OctoPrint/Klipper/PrusaLink/…) — one-click install, no JSON.
  getDigifabDriverCatalog: (slug: string) =>
    request<{
      drivers: { id: string; name: string; summary: string; credentialHint: string; kind: string; manifest: unknown }[];
      edgeAdapters: { id: string; name: string; summary: string; credentialHint: string; kind: string }[];
    }>("GET", `/orgs/${slug}/modules/digifab/drivers/catalog`),
  installDigifabDriver: (slug: string, manifest: unknown) =>
    request<DigifabDriver>("POST", `/orgs/${slug}/modules/digifab/drivers`, manifest as object),
  deleteDigifabDriver: (slug: string, key: string) =>
    request<void>("DELETE", `/orgs/${slug}/modules/digifab/drivers/${encodeURIComponent(key)}`),
  getPrintingProfile: (slug: string, machineId: string) =>
    request<{ machine_id: string; profile: PrintingProfile; filament_types: Array<{ id: string; name: string | null }>; updated_at: string | null }>(
      "GET",
      `/orgs/${slug}/modules/digifab/printing-profiles/${encodeURIComponent(machineId)}`,
    ),
  savePrintingProfile: (slug: string, machineId: string, body: Partial<PrintingProfile>) =>
    request<{ machine_id: string; profile: PrintingProfile; updated_at: string }>(
      "PUT",
      `/orgs/${slug}/modules/digifab/printing-profiles/${encodeURIComponent(machineId)}`,
      body,
    ),
  readBench: (slug:string,machineId:string,offset=0)=>request<BenchPage>("GET",`/orgs/${slug}/modules/digifab/bench/${machineId}?limit=20&offset=${offset}`),
  operateBench: (slug:string,body:BenchOperation)=>request<BenchReport | {identity:string;profile:string} | {off:boolean} | {ok:boolean} | {control_enabled:boolean} | BenchReading>("POST",`/orgs/${slug}/modules/digifab/bench`,body),
  listDigifabLinks: (slug: string) =>
    request<{ items: DigifabLink[] }>("GET", `/orgs/${slug}/modules/digifab/links`),
  createDigifabLink: (
    slug: string,
    body: {
      connection_id: string;
      remote_device_id: string;
      remote_device_name?: string | null;
      machine_id: string;
      machine_label?: string | null;
    },
  ) => request<DigifabLink>("POST", `/orgs/${slug}/modules/digifab/links`, body),
  deleteDigifabLink: (slug: string, id: string) =>
    request<void>("DELETE", `/orgs/${slug}/modules/digifab/links/${id}`),
  listDigifabJobs: (slug: string, opts?: { limit?: number; cursor?: string; status?: string }) => {
    const q = new URLSearchParams();
    if (opts?.limit) q.set("limit", String(opts.limit));
    if (opts?.cursor) q.set("cursor", opts.cursor);
    if (opts?.status) q.set("status", opts.status);
    const qs = q.toString();
    return request<{ items: DigifabJob[]; next_cursor: string | null; total?: number }>("GET", `/orgs/${slug}/modules/digifab/jobs${qs ? `?${qs}` : ""}`);
  },
  getDigifabJob: (slug: string, id: string) =>
    request<DigifabJob>("GET", `/orgs/${slug}/modules/digifab/jobs/${id}`),
  cancelDigifabJob: (slug: string, id: string) =>
    request<CancelResult>("POST", `/orgs/${slug}/modules/digifab/jobs/${id}/cancel`, {}),
  // Explicit path back from a failed/cancelled job — re-queues + re-sends.
  retryDigifabJob: (slug: string, id: string) =>
    request<{ status: string; sent?: boolean; pooled?: boolean; remote_job_id?: string | null; reason?: string }>("POST", `/orgs/${slug}/modules/digifab/jobs/${id}/retry`, {}),
  // "Print this again" — clones a (typically completed) job into a fresh one and sends it.
  reprintDigifabJob: (slug: string, id: string, opts: { again?: boolean } = {}) =>
    request<{ job: DigifabJob; status: string; sent?: boolean; pooled?: boolean; reason?: string }>("POST", `/orgs/${slug}/modules/digifab/jobs/${id}/reprint`, opts.again ? { again: true } : {}),
  // Cockpit live-control: pause / resume a running job (501 if the driver can't).
  pauseDigifabJob: (slug: string, id: string) =>
    request<{ status: string }>("POST", `/orgs/${slug}/modules/digifab/jobs/${id}/pause`, {}),
  resumeDigifabJob: (slug: string, id: string) =>
    request<{ status: string }>("POST", `/orgs/${slug}/modules/digifab/jobs/${id}/resume`, {}),
  deleteDigifabJob: (slug: string, id: string) =>
    request<void>("DELETE", `/orgs/${slug}/modules/digifab/jobs/${id}`),
  createDigifabJob: (
    slug: string,
    body: {
      connection_id?: string;
      file_ref: string;
      target_device?: string | null;
      target_tag?: string | null;
      target_pool?: string | null;
      material_part_id?: string | null;
      material_grams?: number | null;
      material_grams_by_tool?: number[] | null;
      material_type?: string | null;
      file_id?: string | null;
      linked_machine_id?: string | null;
      linked_task_id?: string | null;
      /** A build (BoM) this job produces — consumed from inventory on send. */
      linked_build_id?: string | null;
      build_qty?: number;
      priority?: number;
      max_attempts?: number;
    },
  ) => request<DigifabJob>("POST", `/orgs/${slug}/modules/digifab/jobs`, body),
  /** Builds the workspace has defined (for the New-Job "produces a build" picker).
   *  404s when the builds module isn't enabled — callers tolerate an empty list. */
  listDigifabBuilds: (slug: string) =>
    request<{ items: Array<{ id: string; name: string }> }>("GET", `/orgs/${slug}/modules/builds/builds`),
  updateDigifabJob: (slug: string, id: string, body: { priority?: number; max_attempts?: number; metadata?: Record<string, unknown> }) =>
    request<DigifabJob>("PATCH", `/orgs/${slug}/modules/digifab/jobs/${id}`, body),
  // ─── Makes: one fabrication run, request to outcome (services.md §13) ───
  listMakes: (slug: string, q?: string) =>
    request<{ items: MakeSummary[] }>("GET", `/orgs/${slug}/modules/digifab/makes${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  /** Print this: a Make for the model, the printer it fits, a slice. Sends nothing. */
  printThis: (slug: string, body: { file_id?: string; make_id?: string; prompt?: string; source?: string; source_lang?: "build123d" | "openscad"; template?: string; params?: Record<string, unknown>; material: string; color?: string; quantity?: number }) =>
    request<PrintThisStarted>("POST", `/orgs/${slug}/modules/digifab/makes/print-this`, body),
  /** The one yes: start a Make's waiting print. */
  startMakePrint: (slug: string, makeId: string, confirmHash: string) => request<{ ok: true; status: string }>("POST", `/orgs/${slug}/modules/digifab/makes/${makeId}/print/start`, { confirm_hash: confirmHash }),
  startNextMakePrint: (slug: string, makeId: string, confirmHash?: string) => request<{ ok: true; status: string }>("POST", `/orgs/${slug}/modules/digifab/makes/${makeId}/print/next`, { bed_clear: true, ...(confirmHash ? { confirm_hash: confirmHash } : {}) }),
  reviewMakePrintBatch: (slug: string, makeId: string, quantity?: number) => request<{ ok: true; status: string }>("POST", `/orgs/${slug}/modules/digifab/makes/${makeId}/print/review`, { quantity }),
  cancelMakePrintBatch: (slug: string, makeId: string) => request<{ ok: true; status: string }>("POST", `/orgs/${slug}/modules/digifab/makes/${makeId}/print/cancel`, {}),
  listMakePrintBatches: async (slug: string) => {
    const items: MakePrintBatchSummary[] = [];
    let offset = 0;
    for (;;) {
      const page = await request<{ items: MakePrintBatchSummary[]; total: number | null; complete: boolean; next_offset: number | null }>("GET", `/orgs/${slug}/modules/digifab/makes/print-batches?offset=${offset}`);
      items.push(...page.items);
      if (page.complete) return { items };
      if (page.next_offset == null || page.next_offset <= offset) throw new Error("The next batch page could not be read.");
      offset = page.next_offset;
    }
  },
  getMake: (slug: string, id: string) => request<MakeDetail>("GET", `/orgs/${slug}/modules/digifab/makes/${id}`),
  createMake: (slug: string, body: MakeCreateBody) => request<MakeSummary>("POST", `/orgs/${slug}/modules/digifab/makes`, body),
  patchMake: (slug: string, id: string, body: { name?: string; outcome?: "pass" | "fail" | null; outcome_notes?: string; metadata?: Record<string, unknown> }) =>
    request<MakeSummary>("PATCH", `/orgs/${slug}/modules/digifab/makes/${id}`, body),
  deleteMake: (slug: string, id: string) => request<void>("DELETE", `/orgs/${slug}/modules/digifab/makes/${id}`),
  addMakeFiles: (slug: string, id: string, body: { step: "model" | "slice"; files: Array<{ file_id: string; role: MakeFileRole }> }) =>
    request<{ id: string }>("POST", `/orgs/${slug}/modules/digifab/makes/${id}/files`, body),
  // ─── digifab production runs (quantity-driven scheduler on pools) ───
  listDigifabRuns: (slug: string) =>
    request<{ items: DigifabRun[] }>("GET", `/orgs/${slug}/modules/digifab/runs`),
  createDigifabRun: (
    slug: string,
    body: { name: string; pool_id: string; file_id?: string; file_ref?: string; parts_per_plate: number; target_qty: number; material_part_id?: string; material_grams?: number },
  ) => request<{ id: string; status: string }>("POST", `/orgs/${slug}/modules/digifab/runs`, body),
  patchDigifabRun: (slug: string, id: string, body: { status?: "active" | "paused" | "cancelled"; completed_qty?: number }) =>
    request<{ id: string; status: string; completed_qty: number }>("PATCH", `/orgs/${slug}/modules/digifab/runs/${id}`, body),
  listDigifabPools: (slug: string) =>
    request<{ items: DigifabPool[] }>("GET", `/orgs/${slug}/modules/digifab/pools`),
  createDigifabPool: (slug: string, name: string) =>
    request<DigifabPool>("POST", `/orgs/${slug}/modules/digifab/pools`, { name }),
  deleteDigifabPool: (slug: string, id: string) =>
    request<void>("DELETE", `/orgs/${slug}/modules/digifab/pools/${id}`),
  addDigifabPoolMember: (slug: string, poolId: string, connection_id: string, remote_device_id: string) =>
    request<{ ok: boolean }>("POST", `/orgs/${slug}/modules/digifab/pools/${poolId}/members`, {
      connection_id,
      remote_device_id,
    }),
  removeDigifabPoolMember: (slug: string, poolId: string, connectionId: string, deviceId: string) =>
    request<void>(
      "DELETE",
      `/orgs/${slug}/modules/digifab/pools/${poolId}/members/${connectionId}/${encodeURIComponent(deviceId)}`,
    ),
  // Migrate an FDM Monster farm in: "direct" recreates each printer as its own
  // connection (drops FDMM); "mirror" keeps FDMM + pools its printers.
  importDigifabFdmMonster: (
    slug: string,
    body: { base_url: string; api_key?: string; username?: string; password?: string; mode: "direct" | "mirror"; pool_name: string },
  ) =>
    request<{ mode: string; pool_id: string; pool_name: string; created?: number; skipped?: number; mirrored?: number }>(
      "POST",
      `/orgs/${slug}/modules/digifab/import/fdm-monster`,
      body,
    ),
  bulkAddDigifabConnections: (
    slug: string,
    body: {
      default_type: string;
      pool_name?: string;
      test?: boolean;
      printers: { name?: string; url: string; api_key?: string; username?: string; password?: string; type?: string }[];
    },
  ) =>
    request<{
      created: number;
      failed: number;
      pool_id?: string;
      pool_name?: string;
      results: { index: number; name: string; url: string; type: string; status: "created" | "failed"; connection_id?: string; reachable?: boolean; detail?: string }[];
    }>("POST", `/orgs/${slug}/modules/digifab/bulk/connections`, body),
  detectDigifabType: (slug: string, body: { url: string; api_key?: string }) =>
    request<{ type: string | null; detail: string }>("POST", `/orgs/${slug}/modules/digifab/bulk/detect`, body),
  // Slicer metadata (filament material + grams) parsed from a stored file, to
  // pre-fill the New-job form instead of asking the operator to retype it.
  getDigifabSlicerMeta: (slug: string, fileId: string) =>
    request<{ material: string | null; filament_g: number | null; filament_g_by_tool?: number[] | null; estimated_sec: number | null }>(
      "GET",
      `/orgs/${slug}/modules/digifab/files/${fileId}/slicer-meta`,
    ),
  getLaserSetup: (slug:string,connectionId:string,deviceId:string) =>
    request<LaserSetup>("GET",`/orgs/${slug}/modules/digifab/laser/setup?connection_id=${encodeURIComponent(connectionId)}&device_id=${encodeURIComponent(deviceId)}`),
  setLaserSetup: (slug:string,body:{connection_id:string;device_id:string;operation:"home"|"commission";station_token?:string;configuration?:LaserCommission}) =>
    request<LaserSetup>("POST",`/orgs/${slug}/modules/digifab/laser/setup`,body),
  cutterStation: (slug:string,connectionId:string,deviceId:string) => request<CutterStationView>("GET",`/orgs/${slug}/modules/digifab/cutter/station?connection_id=${encodeURIComponent(connectionId)}&device_id=${encodeURIComponent(deviceId)}`),
  cutterProfiles: (slug:string,connectionId:string,deviceId:string,offset=0) => request<{items:CutterProfileRecord[];total:number;complete:boolean}>("GET",`/orgs/${slug}/modules/digifab/cutter/profiles?connection_id=${encodeURIComponent(connectionId)}&device_id=${encodeURIComponent(deviceId)}&limit=1000&offset=${offset}`),
  createCutterProfile: (slug:string,body:{connection_id:string;device_id:string;profile:CutterProfile}) => request<CutterProfileRecord>("POST",`/orgs/${slug}/modules/digifab/cutter/profiles`,body),
  updateCutterProfile: (slug:string,id:string,profile:CutterProfile) => request<CutterProfileRecord>("PUT",`/orgs/${slug}/modules/digifab/cutter/profiles/${id}`,profile),
  createCutterPlan: (slug:string,body:{connection_id:string;device_id:string;library_id:string;roll_id:string;mapping:Record<string,string>;quantity:number;length_mm:number;spacing_mm:number;mirror?:boolean;weed_box_mm:number;weed_line_spacing_mm:number;dxf_units:"mm"|"in"}) => request<CutterStationView["plan"]>("POST",`/orgs/${slug}/modules/digifab/cutter/plans`,body),
  cutterControl: (slug:string,body:{connection_id:string;device_id:string;operation:"stop"|"pause"|"resume"|"frame"|"confirm-idle";job_id?:string;file_id?:string;project_hash?:string;station_token?:string;idle_confirmed?:boolean;blade_up_confirmed?:boolean}) => request<{ok:boolean;detail?:string}>("POST",`/orgs/${slug}/modules/digifab/cutter/control`,body),
  cutterOutcome: (slug:string,jobId:string,body:{station_token:string;verdict:"good"|"scrap";used_length_m:number;idle_confirmed:true;blade_up_confirmed:true}) => request<{ok:boolean}>("POST",`/orgs/${slug}/modules/digifab/cutter/jobs/${jobId}/outcome`,body),
  prepareDigifabJob: (slug: string, id: string, stationToken?: string) =>
    request<{ review: DigifabJobReview | null; stationRequired?: { connectionId: string; deviceId: string | null } }>("POST", `/orgs/${slug}/modules/digifab/jobs/${id}/prepare`, stationToken ? { stationToken } : {}),
  registerDigifabStation: (slug: string, connectionId: string, deviceId: string) =>
    request<{ id: string; label: string; token: string }>("POST", `/orgs/${slug}/modules/digifab/stations`, { connection_id: connectionId, device_id: deviceId }),
  listDigifabStations: (slug: string) =>
    request<{ items: Array<{ id: string; label: string; connection_id: string; remote_device_id: string; revoked_at: string | null }> }>("GET", `/orgs/${slug}/modules/digifab/stations`),
  revokeDigifabStation: (slug: string, id: string) =>
    request<{ ok: boolean }>("DELETE", `/orgs/${slug}/modules/digifab/stations/${id}`),
  finishResinPostprocess: (slug: string, jobId: string, step: "wash" | "cure") =>
    request<{ ok: boolean }>("POST", `/orgs/${slug}/modules/digifab/resin/jobs/${jobId}/postprocess`, { step }),
  largeFormatStation:(slug:string,connection:string,device:string)=>request<LargeFormatView>("GET",`/orgs/${slug}/modules/digifab/large-format/station?connection_id=${connection}&device_id=${encodeURIComponent(device)}`),
  largeFormatJobs:(slug:string,connection:string,device:string,offset=0)=>request<{items:LargeFormatHistory[];total:number}>("GET",`/orgs/${slug}/modules/digifab/large-format/jobs?connection_id=${connection}&device_id=${encodeURIComponent(device)}&limit=20&offset=${offset}`),
  planLargeFormat:(slug:string,body:Record<string,unknown>)=>request<{job_id:string}>("POST",`/orgs/${slug}/modules/digifab/large-format/plans`,body),
  refreshLargeFormat:(slug:string,body:{connection_id:string;device_id:string})=>request<{ok:boolean;device:{name:string;state:string;raw:Record<string,unknown>}}>("POST",`/orgs/${slug}/modules/digifab/large-format/refresh`,body),
  stopLargeFormat:(slug:string,body:{connection_id:string;device_id:string})=>request<{ok:boolean;detail?:string}>("POST",`/orgs/${slug}/modules/digifab/large-format/stop`,body),
  largeFormatOutcome:(slug:string,id:string,body:{station_token:string;verdict:"good"|"scrap";used_length_m:number;idle_confirmed:true;ink:Array<{stock_id:string;kind:string;amount_ml:number;estimated:boolean}>})=>request<{ok:boolean}>("POST",`/orgs/${slug}/modules/digifab/large-format/jobs/${id}/outcome`,body),
  digifabStation: (slug: string, connectionId: string, deviceId: string, q = "") =>
    request<MachineStationView>("GET", `/orgs/${slug}/modules/digifab/stations/${connectionId}/${encodeURIComponent(deviceId)}${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  saveLaserSheet: (slug: string, partId: string, material: LaserMaterialTag) =>
    request<{ ok: boolean }>("PUT", `/orgs/${slug}/modules/digifab/stations/sheets/material`, { part_id: partId, laser_sheet: material }),
  confirmLaserSheet: (slug: string, connectionId: string, deviceId: string, jobId: string, sheetId: string, stationToken: string) =>
    request<{ id: string; name: string }>("POST", `/orgs/${slug}/modules/digifab/stations/${connectionId}/${encodeURIComponent(deviceId)}/confirm`, { job_id: jobId, sheet_id: sheetId, station_token: stationToken }),
  sendDigifabJob: (slug: string, id: string, approval?: Pick<DigifabJobReview, "fileId" | "projectHash"> & { stationToken?: string; sheetId?: string; cnc?: import("@cobblr/platform-contract/cnc").CncApproval; cutterChecks?: {media_loaded:true;blade_depth_set:true;native_offset_zero:true;test_cut_checked:true;origin_checked:true} }) =>
    request<{ status: string; remote_job_id: string | null; placement: unknown; uploaded_bytes?: number }>(
      "POST",
      `/orgs/${slug}/modules/digifab/jobs/${id}/send`,
      approval ? { approval } : {},
    ),
  // F-14 — re-pick a printer for an awaiting-assignment job (re-submits the
  // already-uploaded file to an explicit device; no re-upload).
  assignDigifabJob: (slug: string, id: string, deviceId: string) =>
    request<{ status: string; remote_job_id: string | null; placement: unknown }>(
      "POST",
      `/orgs/${slug}/modules/digifab/jobs/${id}/assign`,
      { device_id: deviceId },
    ),
  pollDigifabJob: (slug: string, id: string) =>
    request<{ status: string; terminal: boolean }>(
      "POST",
      `/orgs/${slug}/modules/digifab/jobs/${id}/poll`,
      {},
    ),
  listEdgeBridges: (slug: string) =>
    request<{ bridges: EdgeBridge[]; direct?: DirectEdgeBridge[] }>(
      "GET",
      `/orgs/${slug}/modules/digifab/edge/bridges`,
    ),
};
