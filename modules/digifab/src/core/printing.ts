// The printing seam (docs/modules/digifab-families.md): what the core's farm,
// its job completion and Makes ask the family that runs printers. The farm's
// assign worker and floor give a printer a job only through the family's
// candidates and material refusal; a finished print's material is planned,
// drawn and put back by the family; and a Make's print steps start through it.
// The types are the core's, since the job row and the floor carry them.
import type { Kysely } from "kysely";
import type { DigifabDB } from "../db.js";
import type { Size } from "../model-size.js";

export const MACHINE_KIND = "machines:machine";

/** The selected device takes precedence when a job was reassigned. */
export async function machineOfJob(
  db: Kysely<DigifabDB>,
  job: { linked_machine_id: string | null; connection_id: string | null; target_device: string | null },
): Promise<string | null> {
  if (!job.connection_id || !job.target_device) return job.linked_machine_id;
  const link = await db
    .selectFrom("digifab_device_links")
    .select(["machine_id"])
    .where("connection_id", "=", job.connection_id)
    .where("remote_device_id", "=", job.target_device)
    .executeTakeFirst();
  return link?.machine_id ?? job.linked_machine_id;
}

export interface PrintingProfile {
  /** The neutral printer model id, e.g. "bambulab/a1". */
  printer_model: string | null;
  nozzle_mm: number | null;
  /** [x, y, z] in mm. */
  build_volume_mm: [number, number, number] | null;
  /** An id from the slicer's options. */
  default_quality: string | null;
  /** Filament type id -> the slicer preset to prefer for it on this printer. */
  preset_hints: Record<string, string>;
}

export interface LoadedSpool {
  spool: { kind: string; id: string; name: string | null };
  slot: string | null;
  material: string | null;
  color: string | null;
  grams_left: number | null;
  /** The filament type the spool is filed under, for its preset hint. */
  type_id: string | null;
  values?: Record<string, unknown>;
}

export interface PrinterCandidate {
  machine: { id: string; label: string | null };
  device: { connection_id: string; remote_device_id: string; name: string | null };
  idle: boolean;
  profile: PrintingProfile | null;
  loaded: LoadedSpool[];
  /** Position in the person's pool order; null when in no pool. */
  pool_order: number | null;
}

export interface Draw {
  part_id: string;
  grams: number;
  slot: string | null;
}

export type MaterialPlan = { draws: Draw[]; unfed: Array<{ slot: string; grams: number }>; skipped?: Draw[] };

export interface PrinterMaterial {
 material_type?: string | null;
 material_part_id?: string | null;
 material_grams?: unknown;
 material_grams_by_tool?: unknown;
 material_by_tool?: string[];
 color_by_tool?: string[];
}

export interface PrintThisAsk {
  /** A model (STL or 3MF) or G-code in the workspace's files. */
  file_id?: string;
  prompt?: string;
  source?: string;
  source_lang?: "build123d" | "openscad";
  template?: string;
  params?: Record<string, unknown>;
  quantity?: number;
  /** A Make that already has its model. */
  make_id?: string;
  material: string;
  color?: string | null;
  name?: string;
  /** The part's size when the caller knows it better than the file does. */
  bbox_mm?: Size | null;
  origin?: "page" | "cobb" | "mcp";
}

export type PrintThisResult =
  | { ok: true; make_id: string; created_make: boolean; printer: { machine: string | null; reason: string }; slice_job_id: string | null; summary: string }
  | { ok: false; code: string; error: string; make_id?: string; created_make?: boolean };

/** A Make's print step answers this way. */
export type PrintStepResult = { ok: true; status: string } | { ok: false; code: string; error: string };

/** A finished job's material, as the completion reads it. */
export type CompletedMaterialJob = {
  id: string; file_ref: string; material_part_id: string | null; material_grams: string | null;
  material_grams_by_tool: unknown; linked_machine_id: string | null;
  connection_id: string | null; target_device: string | null;
};

export interface FamilyPrinting {
  /** Every printer the farm may give a job: its machine, device, idle state, Printing profile, loaded spools and pool order. */
  candidates(orgId: string, db: Kysely<DigifabDB>): Promise<PrinterCandidate[]>;
  /** The spools loaded on a machine. */
  loadedFor(orgId: string, machineId: string): Promise<LoadedSpool[]>;
  /** Why this loaded material refuses this job, or null; with nothing loaded, null means the job needs no material. */
  materialRefusal(job: PrinterMaterial, loaded: LoadedSpool[]): string | null;
  /** What a finished print takes from which spool. */
  planCompleted(db: Kysely<DigifabDB>, orgId: string, job: CompletedMaterialJob): Promise<MaterialPlan>;
  /** Take a finished print's planned material from stock. */
  drawCompleted(db: Kysely<DigifabDB>, orgId: string, job: { id: string }): Promise<void>;
  /** Put back what a scrapped print drew; the grams put back. */
  putBack(orgId: string, job: { id: string; material_drawn: unknown }): Promise<number>;
  /** Make's print steps: Print this, start the reviewed print, and a batch's next print, review and cancel. */
  startPrintThis(orgId: string, userId: string | null, ask: PrintThisAsk): Promise<PrintThisResult>;
  startPrint(orgId: string, userId: string | null, makeId: string, confirmHash?: string): Promise<PrintStepResult>;
  startBatch(db: Kysely<DigifabDB>, orgId: string, userId: string | null, makeId: string, confirmHash?: string, bedClear?: boolean): Promise<PrintStepResult>;
  reviewBatch(db: Kysely<DigifabDB>, orgId: string, makeId: string, quantity?: number): Promise<PrintStepResult>;
  cancelBatch(db: Kysely<DigifabDB>, makeId: string): Promise<PrintStepResult>;
  /** A batch print's job finished: settle the batch; false when the job is no batch's. */
  settleBatchForJob(db: Kysely<DigifabDB>, orgId: string, jobId: string, status: "completed" | "failed" | "cancelled"): Promise<boolean>;
  /** Pick Print this and batches up where a restart left them. */
  recover(orgId: string, db: Kysely<DigifabDB>): Promise<void>;
}
