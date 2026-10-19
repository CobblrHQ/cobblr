// Remove a component (builds:remove-component): the handler its manifest entry names. Wired in ./index.ts.
// The same delete as on the build's component list (DELETE /builds/:id/components/:cid).
import { platform, requireActionEntity } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { BuildsDB } from "../db.js";
import { onBuild } from "./build-steps.js";
import { removeComponent } from "./build-steps.js";

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export function registerRemoveComponentAction(): void {
  platform().actions.registerHandler("builds.remove-component", async (ctx) => {
    const build = requireActionEntity(ctx);
    const want = str(ctx.args?.component);
    if (!want) return { ok: false, error: "Say which component: its id, or the part's id." };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<BuildsDB>;
    const rows = await db.selectFrom("builds_components").selectAll().where("build_id", "=", build.id).execute();
    const hit = rows.filter((r) => r.id === want || r.part_id === want || r.sub_assembly_build_id === want);
    if (hit.length !== 1) return { ok: false, error: hit.length ? "More than one component matches; say which by its id." : "No component like that is on this build." };
    const row = await removeComponent(db, build.id, hit[0]!.id);
    if (!row) return { ok: true, skipped: true, summary: "It was already off this build." };
    return {
      ok: true,
      summary: "Took it off what this build is made of.",
      data: { part_id: row.part_id, sub_assembly_build_id: row.sub_assembly_build_id, quantity: Number(row.quantity), optional: row.optional, notes: row.notes },
    };
  });
  platform().actions.registerUndo("builds.remove-component", (result, uctx) => {
    const d = (result as { ok?: unknown; skipped?: unknown; data?: Record<string, unknown> } | null);
    if (d?.ok !== true || d.skipped || !d.data) return null;
    const { part_id, sub_assembly_build_id, ...rest } = d.data;
    return { action_id: "builds:add-component", args: { ...(part_id ? { part_id } : { sub_assembly_build_id }), ...rest }, ...onBuild(uctx) };
  });
}
