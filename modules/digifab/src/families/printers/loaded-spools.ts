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
// spool in slot N. Each draw invokes inventory's stock action in grams,
// which converts into the spool's own unit and writes
// to the spool's history with the job attached. What was drawn is kept on the
// job, so a print scrapped at the bed puts back exactly that.

import { normaliseActionResult } from "@cobblr/platform-contract/action-result";
import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { DigifabDB } from "../../db.js";
import { MACHINE_KIND, machineOfJob, type Draw, type MaterialPlan } from "../../core/printing.js";

export type { Draw, MaterialPlan } from "../../core/printing.js";
export { MACHINE_KIND, machineOfJob } from "../../core/printing.js";

/** The kind a spool is placed as (a thing kept in a collection). */
const THING_KIND = "inventory:part";

export interface Loaded {
  slot: string;
  partId: string;
}


/** The spools loaded on a machine, by slot. */
export async function loadedOn(orgId: string, machineId: string): Promise<Array<Loaded & { kind: string }>> {
  const contents = await platform().placement.contents({ orgId, container: { kind: MACHINE_KIND, id: machineId } });
  return contents
    .filter((c) => c.kind === THING_KIND && typeof c.slot === "string" && c.slot.trim() !== "")
    .map((c) => ({ slot: c.slot!.trim(), partId: c.id, kind: c.kind }))
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
): { draws: Array<Draw & { slot: string }>; unfed: Array<{ slot: string; grams: number }> } {
  const tools = byTool && byTool.some((g) => g > 0) ? [...byTool] : total && total > 0 ? [total] : [];
  const used = tools.map((grams, i) => ({ slot: String(i + 1), grams })).filter((t) => t.grams > 0);
  if (!used.length) return { draws: [], unfed: [] };
  if (loaded.length === 1 && used.length === 1) {
    return { draws: [{ part_id: loaded[0]!.partId, grams: used[0]!.grams, slot: loaded[0]!.slot }], unfed: [] };
  }
  const bySlot = new Map(loaded.map((l) => [l.slot, l.partId]));
  const draws: Array<Draw & { slot: string }> = [];
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

type MaterialJob = {
  id: string; file_ref: string; material_part_id: string | null; material_grams: string | null;
  material_grams_by_tool: unknown; linked_machine_id: string | null;
  connection_id: string | null; target_device: string | null;
};

export async function planCompletedMaterial(db: Kysely<DigifabDB>, orgId: string, job: MaterialJob): Promise<MaterialPlan> {
  const total = job.material_grams != null ? Number(job.material_grams) : null;
  if (job.material_part_id) return { draws: total && total > 0 ? [{ part_id: job.material_part_id, grams: total, slot: null }] : [], unfed: [] };
  const byTool = gramsByTool(job.material_grams_by_tool);
  if (!byTool && !(total && total > 0)) return { draws: [], unfed: [] };
  const machineId = await machineOfJob(db, job);
  return machineId ? planDraw(await loadedOn(orgId, machineId), byTool, total) : { draws: [], unfed: [] };
}

export async function drawForCompletedJob(db: Kysely<DigifabDB>, orgId: string, job: { id: string }): Promise<void> {
  for (;;) {
    const more = await db.transaction().execute(async trx => {
      // Serialize delivery through the job lock. Inventory commits separately;
      // its source ledger covers a crash after that commit but before our ack.
      const row = await trx.selectFrom("digifab_jobs").select(["material_plan", "material_drawn", "material_pending", "file_ref"])
        .where("id", "=", job.id).forUpdate().executeTakeFirst();
      if (!row?.material_pending || !row.material_plan) return false;
      const plan = row.material_plan as MaterialPlan;
      const drawn = Array.isArray(row.material_drawn) ? row.material_drawn as Draw[] : [];
      const settled = [...drawn, ...(plan.skipped ?? [])];
      const next = plan.draws.find(d => !settled.some(a => a.part_id === d.part_id && a.slot === d.slot));
      if (!next) {
        await trx.updateTable("digifab_jobs").set({ material_pending: false, updated_at: new Date() }).where("id", "=", job.id).execute();
        return false;
      }
      const result = normaliseActionResult(await platform().actions.invoke("inventory:adjust-stock", {
        orgId, userId: null, entity: { kind: THING_KIND, id: next.part_id },
        args: { partId: next.part_id, delta: -next.grams, unit: "g", once: true, reason: `Print: ${row.file_ref}`, sourceKind: "digifab:job", sourceId: job.id },
        event: { name: "digifab.print.consumed", payload: { jobId: job.id, slot: next.slot }, actor: { user_id: null, display_name: null, auth_method: "system" }, timestamp: new Date().toISOString(), trigger_type: "event" },
      }), "inventory:adjust-stock");
      const alreadyApplied = !result.ok && result.skipped && result.error === "already applied for this source";
      const externallyTracked = !result.ok && result.skipped && result.error.startsWith("externally tracked by ");
      if (!result.ok && !alreadyApplied && !externallyTracked) throw new Error(result.error);
      const applied = [...drawn, ...(!externallyTracked ? [next] : [])];
      const skipped = [...(plan.skipped ?? []), ...(externallyTracked ? [next] : [])];
      const remaining = plan.draws.filter(d => d !== next && !settled.some(a => a.part_id === d.part_id && a.slot === d.slot));
      await trx.updateTable("digifab_jobs").set({ material_drawn: JSON.stringify(applied), material_plan: JSON.stringify({ ...plan, skipped }), material_pending: remaining.length > 0, updated_at: new Date() }).where("id", "=", job.id).execute();
      return remaining.length > 0;
    });
    if (!more) return;
  }
}

// PERMANENT RECONCILE: completion commits pending material with the job;
// each visit delivers unacknowledged stock operations after crashes or outages.
export function registerMaterialRecovery(): void {
  platform().sweeps.register({
    name: "digifab.material-recovery", module: "digifab", everyMs: 30_000, firstAfterMs: 10_000,
    visit: async ({ orgId, db: raw }) => {
      const db = raw as Kysely<DigifabDB>;
      let cursor: string | null = null;
      for (;;) {
        let query = db.selectFrom("digifab_jobs").select("id").where("material_pending", "=", true).orderBy("id").limit(100);
        if (cursor) query = query.where("id", ">", cursor);
        const jobs = await query.execute();
        for (const job of jobs) {
          try { await drawForCompletedJob(db, orgId, job); }
          catch (error) { platform().health.notePassFailure("digifab.material-recovery", orgId, error); }
        }
        if (jobs.length < 100) return;
        cursor = jobs[jobs.length - 1]!.id;
      }
    },
  });
}
