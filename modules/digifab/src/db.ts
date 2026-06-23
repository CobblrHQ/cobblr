// Tenant-side DB types + request helpers for digifab.

import type { Generated, Kysely } from "kysely";
import type { Request } from "express";

export interface DigifabConnectionsTable {
  id: Generated<string>;
  /** Driver type: "fdm_monster" | "mock" | … */
  type: string;
  label: string;
  base_url: string;
  /** AES-GCM ciphertext of { apiKey } — never returned to clients. */
  credentials_enc: string;
  config: Generated<Record<string, unknown>>;
  enabled: Generated<boolean>;
  /** Cached capability probe (e.g. { routing: true }). */
  capabilities: Generated<Record<string, unknown>>;
  last_sync_at: Date | null;
  last_sync_status: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface DigifabJobsTable {
  id: Generated<string>;
  /** Null for an unassigned pool job — the assignment worker sets it. */
  connection_id: string | null;
  file_ref: string;
  target_device: string | null;
  target_tag: string | null;
  /** A Cobblr pool to drip this job onto a free member (queue mode). */
  target_pool: string | null;
  /** Filament the print consumes — an inventory part + grams. On completion a
   *  seeded wire deducts `material_grams` from `material_part_id`'s stock. */
  material_part_id: string | null;
  material_grams: string | null;
  remote_file_id: string | null;
  remote_job_id: string | null;
  status: Generated<string>;
  /** Higher sorts sooner in the assignment queue. */
  priority: Generated<number>;
  /** Reprint-on-fail: times (re)sent + the cap before a failure goes terminal. */
  attempts: Generated<number>;
  max_attempts: Generated<number>;
  progress: number | null;
  error: string | null;
  /** Consecutive poll errors (F-12) — reset to 0 on a successful poll; a job is
   *  only declared `failed` after this crosses the threshold. */
  poll_errors: Generated<number>;
  /** A stored core-files file whose bytes are uploaded at send. */
  file_id: string | null;
  linked_machine_id: string | null;
  linked_task_id: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  last_polled_at: Date | null;
}

export interface DigifabDeviceLinksTable {
  id: Generated<string>;
  connection_id: string;
  remote_device_id: string;
  remote_device_name: string | null;
  machine_id: string;
  machine_label: string | null;
  created_at: Generated<Date>;
}

export interface DigifabDriversTable {
  id: Generated<string>;
  /** Driver key — a connection's `type` references this (or a built-in key). */
  key: string;
  name: string;
  /** "declarative" | "edge-adapter". Built-ins (fdm_monster/mock) aren't stored. */
  kind: string;
  /** The manifest (declarative) or { adapterUrl } (edge-adapter). */
  spec: Generated<Record<string, unknown>>;
  enabled: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface DigifabPoolsTable {
  id: Generated<string>;
  name: string;
  config: Generated<Record<string, unknown>>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface DigifabPoolMembersTable {
  pool_id: string;
  connection_id: string;
  remote_device_id: string;
  loaded_material: string | null;
  created_at: Generated<Date>;
}

// A device that finished/failed a print and needs a human to clear the bed
// before it can take new work. The assign worker skips these; the fleet view
// surfaces them; POST …/ready deletes the row.
export interface DigifabDeviceAttentionTable {
  connection_id: string;
  remote_device_id: string;
  job_id: string | null;
  reason: string; // print-completed | print-failed
  note: string | null;
  created_at: Generated<Date>;
}

export interface DigifabDeviceSettingsTable {
  connection_id: string;
  remote_device_id: string;
  camera_url: string | null;
  snapshot_relay: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface DigifabDeviceSnapshotsTable {
  connection_id: string;
  remote_device_id: string;
  jpeg: Buffer;
  updated_at: Generated<Date>;
}

/** A notification destination (a Discord channel = its webhook), defined once
 *  and referenced by many print-update rules. */
export interface DigifabChannelsTable {
  id: Generated<string>;
  label: string;
  kind: Generated<string>; // 'discord'
  credentials_enc: string; // AES-GCM webhook URL
  enabled: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

/** A print-update rule: scope → channel → cadence → message template. */
export interface DigifabPrintRulesTable {
  id: Generated<string>;
  label: string;
  scope_type: Generated<string>; // 'all' | 'printer' | 'tag' | 'family'
  scope_value: string | null;
  channel_id: string;
  events: Generated<Record<string, boolean>>;
  cadence: Generated<Array<{ type: "percent" | "minutes" | "layers"; every: number }>>;
  cap_minutes: number | null;
  message: Generated<{ title?: string; body?: string; photo?: boolean }>;
  /** Pre/post hook steps run around the fire (control a printer / wait). */
  pre_actions: Generated<Array<{ control: string; params?: Record<string, unknown> } | { wait_ms: number }>>;
  post_actions: Generated<Array<{ control: string; params?: Record<string, unknown> } | { wait_ms: number }>>;
  enabled: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

/** Per (rule, printer) fire bookkeeping — thresholds fire once, cap enforced. */
export interface DigifabPrintRuleStateTable {
  rule_id: string;
  serial: string;
  job_key: string | null;
  last_percent: number | null;
  last_layer: number | null;
  last_fire_at: Date | null;
}

export interface DigifabDB {
  digifab_channels: DigifabChannelsTable;
  digifab_print_rules: DigifabPrintRulesTable;
  digifab_print_rule_state: DigifabPrintRuleStateTable;
  digifab_connections: DigifabConnectionsTable;
  digifab_jobs: DigifabJobsTable;
  digifab_device_links: DigifabDeviceLinksTable;
  digifab_drivers: DigifabDriversTable;
  digifab_pools: DigifabPoolsTable;
  digifab_pool_members: DigifabPoolMembersTable;
  digifab_device_attention: DigifabDeviceAttentionTable;
  digifab_device_settings: DigifabDeviceSettingsTable;
  digifab_device_snapshots: DigifabDeviceSnapshotsTable;
  digifab_bambu_status: DigifabBambuStatusTable;
  digifab_edge_shares: DigifabEdgeSharesTable;
  digifab_observed_prints: DigifabObservedPrintsTable;
  digifab_bambu_tasks: DigifabBambuTasksTable;
  digifab_library: DigifabLibraryTable;
  digifab_printer_files: DigifabPrinterFilesTable;
  digifab_printer_file_meta: DigifabPrinterFileMetaTable;
}

/** Durable cache of one on-disk gcode file + its slicer thumbnail/estimate. The
 *  warmer keeps it fresh; the UI reads it instead of the printer. Thumbnail is
 *  fetched once (immutable per name/size/modified) and kept. */
export interface DigifabPrinterFilesTable {
  connection_id: string;
  device_id: string;
  name: string;
  size: number | null;
  modified: string | null;
  print_time_sec: number | null;
  filament_mm: number | null;
  num_layers: number | null;
  height: number | null;
  generated_by: string | null;
  thumbnail: string | null;
  /** Null = estimate + thumbnail not yet pulled (the warmer backfills it). */
  info_fetched_at: Date | null;
  list_seen_at: Generated<Date>;
}

/** Per-device cache bookkeeping: when the list was last pulled + warm heartbeat. */
export interface DigifabPrinterFileMetaTable {
  connection_id: string;
  device_id: string;
  list_fetched_at: Date | null;
  warm_at: Date | null;
}

/** A stored 3MF/gcode file you send to machines, with the slicer-embedded plate
 *  thumbnail extracted. Bytes live in core-files (file_id); thumbnail is its own
 *  small core-files image. */
export interface DigifabLibraryTable {
  id: Generated<string>;
  name: string;
  file_id: string;
  thumbnail_file_id: string | null;
  kind: string; // '3mf' | 'gcode'
  size_bytes: Generated<number>;
  plate_count: Generated<number>;
  notes: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

/** The full cloud print-history entry per task (raw JSON kept verbatim). */
export interface DigifabBambuTasksTable {
  connection_id: string;
  task_id: string;
  raw: Record<string, unknown>;
  captured_at: Generated<Date>;
}

/** A finished print Cobblr didn't start (no job row) but watched complete via
 *  live telemetry — e.g. a Bambu print kicked off from Bambu Studio. */
export interface DigifabObservedPrintsTable {
  id: Generated<string>;
  connection_id: string;
  serial: string;
  file_ref: string | null;
  status: string; // 'completed' | 'failed'
  started_at: Date | null;
  ended_at: Generated<Date>;
  created_at: Generated<Date>;
}

/** A scoped grant of edge-bridge machines, redeemable into the recipient's
 *  chosen workspace(s). One revoke cuts off every redemption (relay checks the
 *  grant live). */
export interface EdgeShareRedeemer {
  org: string;
  label: string;
  at: string;
}
export interface DigifabEdgeSharesTable {
  id: Generated<string>;
  label: string;
  scope: string; // 'read' | 'write'
  instances: Generated<string[]>; // owner edge_adapter connection ids
  token_hash: string | null;
  grantee_orgs: Generated<EdgeShareRedeemer[]>;
  created_at: Generated<Date>;
  expires_at: Date | null;
  redeemed_at: Date | null;
  revoked_at: Date | null;
  last_used_at: Date | null;
}

/** Live cloud-MQTT telemetry per Bambu printer, written by the bambu-pump and
 *  read (fresh) by the fleet. One row per (connection, serial). */
export interface DigifabBambuStatusTable {
  connection_id: string;
  serial: string;
  state: string | null;
  stage: string | null;
  nozzle_actual: number | null;
  nozzle_target: number | null;
  bed_actual: number | null;
  bed_target: number | null;
  chamber_actual: number | null;
  chamber_target: number | null;
  progress: number | null;
  remaining_min: number | null;
  layer_num: number | null;
  total_layers: number | null;
  /** The full live MQTT `print` object, raw. */
  report: Record<string, unknown> | null;
  updated_at: Generated<Date>;
}

export type OrgRole = "owner" | "admin" | "member" | "guest";

interface RequestWithTenant {
  tenant?: {
    org: { id: string; name: string; slug: string };
    role: OrgRole;
    db: unknown;
  };
  session?: { id: string; email: string; display_name: string };
}

export function tenantDb(req: Request): Kysely<DigifabDB> {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("digifab route called without tenant context");
  return t.db as Kysely<DigifabDB>;
}

export function tenantContext(req: Request) {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("digifab route called without tenant context");
  return { org: t.org, role: t.role };
}
