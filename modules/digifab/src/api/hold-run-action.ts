// Pause or cancel a production run (digifab:hold-run): the handler its manifest entry names. Wired in ./index.ts.
// The run page's Pause and Cancel (PATCH /runs/:id). Only toward stopped: a
// resume sends plates to printers again, so it stays at the page.
import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { DigifabDB } from "../db.js";
import { updateRun } from "./runs.js";

export function registerHoldRunAction(): void {
  platform().actions.registerHandler("digifab.hold-run", async (ctx) => {
    const a = (ctx.args ?? {}) as Record<string, unknown>;
    const op = a.operation === "cancel" ? "cancelled" : a.operation === "pause" ? "paused" : null;
    if (!op) return { ok: false, error: "Say pause or cancel." };
    const want = typeof a.run === "string" ? a.run.trim() : "";
    if (!want) return { ok: false, error: "Say which run." };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<DigifabDB>;
    const runs = await db.selectFrom("digifab_production_runs").select(["id", "name", "status"]).execute();
    const hit = runs.filter((r) => r.id === want || r.name.toLowerCase() === want.toLowerCase());
    if (hit.length !== 1) return { ok: false, error: hit.length ? `More than one run is called "${want}".` : `No run called "${want}".` };
    const run = hit[0]!;
    if (run.status === "completed" || run.status === "cancelled") return { ok: true, skipped: true, summary: `The ${run.name} run is already ${run.status}.` };
    const r = await updateRun(db as never, ctx.orgId, run.id, { status: op });
    if (r.status !== 200) return { ok: false, error: String((r.body.error as { message?: string } | undefined)?.message ?? "It could not be changed.") };
    return {
      ok: true,
      summary: op === "paused" ? `Paused the ${run.name} run: no new plates go out; one already printing finishes.` : `Cancelled the ${run.name} run and its queued plates; one already printing finishes.`,
      data: { run: run.id, status: op },
    };
  });
}
