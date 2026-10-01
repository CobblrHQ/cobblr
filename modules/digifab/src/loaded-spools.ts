// Loaded spools: which spool is on which printer, and what a print takes off it.
//
// A printer is a place. A spool loaded on it is placed inside the printer's
// machine record, in a numbered slot (core-placement): "1" on a plain printer,
// "1".."4" with an AMS, "1".."5" on an MMU. Loading a spool into a slot that
// holds one sends that one back to the shelf it came from (placement's
// one-to-a-slot), so a printer never holds two spools in one slot.
//
// A completed print with no spool picked on the job draws its grams from the
// spools loaded on its printer: the slicer's grams for filament N come off the
// spool in slot N. Each draw is its own `digifab.print.consumed` event, in
// grams, which inventory's wire converts into the spool's own unit and writes
// to the spool's history with the job attached. What was drawn is kept on the
// job, so a print scrapped at the bed puts back exactly that.

import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { DigifabDB } from "./db.js";

export const MACHINE_KIND = "machines:machine";
/** The kind a spool is placed as (a thing kept in a collection). */
const THING_KIND = "inventory:part";

export interface Loaded {
  slot: string;
  partId: string;
}

export interface Draw {
  part_id: string;
  grams: number;
  slot: string;
}

/** The machine a job prints on: its own link, else its device's. */
export async function machineOfJob(
  db: Kysely<DigifabDB>,
  job: { linked_machine_id: string | null; connection_id: string | null; target_device: string | null },
): Promise<string | null> {
  if (job.linked_machine_id) return job.linked_machine_id;
  if (!job.connection_id || !job.target_device) return null;
  const link = await db
    .selectFrom("digifab_device_links")
    .select(["machine_id"])
    .where("connection_id", "=", job.connection_id)
    .where("remote_device_id", "=", job.target_device)
    .executeTakeFirst();
  return link?.machine_id ?? null;
}

/** The spools loaded on a machine, by slot. */
export async function loadedOn(orgId: string, machineId: string): Promise<Loaded[]> {
  const contents = await platform().placement.contents({ orgId, container: { kind: MACHINE_KIND, id: machineId } });
  return contents
    .filter((c) => c.kind === THING_KIND && typeof c.slot === "string" && c.slot.trim() !== "")
    .map((c) => ({ slot: c.slot!.trim(), partId: c.id }))
    .sort((a, b) => Number(a.slot) - Number(b.slot) || a.slot.localeCompare(b.slot));
}

/** Which loaded spool pays for which grams. Filament N is slot N. One spool
 *  loaded and one filament used: that spool pays, whatever its slot (a plain
 *  printer, or one AMS lane in use). Grams for a slot with nothing loaded are
 *  reported, never moved onto another spool. Pure. */
export function planDraw(
  loaded: readonly Loaded[],
  byTool: readonly number[] | null,
  total: number | null,
): { draws: Draw[]; unfed: Array<{ slot: string; grams: number }> } {
  const tools = byTool && byTool.some((g) => g > 0) ? [...byTool] : total && total > 0 ? [total] : [];
  const used = tools.map((grams, i) => ({ slot: String(i + 1), grams })).filter((t) => t.grams > 0);
  if (!used.length) return { draws: [], unfed: [] };
  if (loaded.length === 1 && used.length === 1) {
    return { draws: [{ part_id: loaded[0]!.partId, grams: used[0]!.grams, slot: loaded[0]!.slot }], unfed: [] };
  }
  const bySlot = new Map(loaded.map((l) => [l.slot, l.partId]));
  const draws: Draw[] = [];
  const unfed: Array<{ slot: string; grams: number }> = [];
  for (const t of used) {
    const part = bySlot.get(t.slot);
    if (part) draws.push({ part_id: part, grams: t.grams, slot: t.slot });
    else unfed.push(t);
  }
  return { draws, unfed };
}

/** A tool's grams as stored on a job: numbers, tool 1 first; null otherwise. */
export function gramsByTool(raw: unknown): number[] | null {
  if (!Array.isArray(raw)) return null;
  const out = raw.map((g) => (typeof g === "number" && Number.isFinite(g) && g > 0 ? g : 0));
  return out.some((g) => g > 0) ? out : null;
}

/** Take a completed print's grams off the spools loaded on its printer, and
 *  keep what was taken on the job. Nothing when the job names its own spool
 *  (that path deducts through print.completed as before). */
export async function drawForCompletedJob(
  db: Kysely<DigifabDB>,
  orgId: string,
  job: {
    id: string;
    file_ref: string;
    material_part_id: string | null;
    material_grams: string | null;
    material_grams_by_tool: unknown;
    linked_machine_id: string | null;
    connection_id: string | null;
    target_device: string | null;
  },
): Promise<{ draws: Draw[]; unfed: Array<{ slot: string; grams: number }> }> {
  if (job.material_part_id) return { draws: [], unfed: [] };
  const total = job.material_grams != null ? Number(job.material_grams) : null;
  const byTool = gramsByTool(job.material_grams_by_tool);
  if (!byTool && !(total && total > 0)) return { draws: [], unfed: [] };
  const machineId = await machineOfJob(db, job);
  if (!machineId) return { draws: [], unfed: [] };
  const plan = planDraw(await loadedOn(orgId, machineId), byTool, total);
  if (!plan.draws.length && !plan.unfed.length) return plan;
  // The claim: a job draws once. Two completions of one job (a second poller,
  // a replayed terminal) find material_drawn already set and take nothing.
  const claimed = await db
    .updateTable("digifab_jobs")
    .set({ material_drawn: JSON.stringify(plan.draws) as never, updated_at: new Date() })
    .where("id", "=", job.id)
    .where("material_drawn", "is", null)
    .returning(["id"])
    .executeTakeFirst();
  if (!claimed) return { draws: [], unfed: [] };
  for (const d of plan.draws) {
    await platform().events.emit("digifab.print.consumed", {
      orgId,
      jobId: job.id,
      partId: d.part_id,
      delta: -d.grams,
      unit: "g",
      once: true,
      slot: d.slot,
      reason: `Print: ${job.file_ref}`,
      sourceKind: "digifab:job",
      sourceId: job.id,
    });
  }
  if (plan.unfed.length) {
    console.log(`[digifab] job ${job.id}: nothing loaded in slot ${plan.unfed.map((u) => u.slot).join(", ")}; ${plan.unfed.map((u) => `${u.grams} g`).join(", ")} not taken off a spool`);
  }
  return plan;
}

/** A scrapped print puts back what it drew from each loaded spool. */
export async function putBackDrawn(orgId: string, job: { id: string; material_drawn: unknown }): Promise<number> {
  const drawn = Array.isArray(job.material_drawn) ? (job.material_drawn as Draw[]) : [];
  let n = 0;
  for (const d of drawn) {
    if (!d || typeof d.part_id !== "string" || !(Number(d.grams) > 0)) continue;
    await platform().events.emit("digifab.print.consumed", {
      orgId,
      jobId: job.id,
      partId: d.part_id,
      delta: Number(d.grams),
      unit: "g",
      once: true,
      slot: d.slot,
      reason: "Scrapped print",
      sourceKind: "digifab:job",
      sourceId: job.id,
    });
    n++;
  }
  return n;
}
