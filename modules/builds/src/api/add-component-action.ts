// Add a component (builds:add-component): the handler its manifest entry names. Wired in ./index.ts.
// The same insert as Add component on the build (POST /builds/:id/components).
import { platform, requireActionEntity } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { BuildsDB } from "../db.js";
import { onBuild } from "./build-steps.js";
import { addComponent } from "./build-steps.js";

const num = (v: unknown): number | undefined => (v === undefined || v === null || v === "" ? undefined : Number(v));
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export function registerAddComponentAction(): void {
  platform().actions.registerHandler("builds.add-component", async (ctx) => {
    const build = requireActionEntity(ctx);
    const a = (ctx.args ?? {}) as Record<string, unknown>;
    const part = str(a.part_id);
    const sub = str(a.sub_assembly_build_id);
    const quantity = num(a.quantity) ?? 1;
    if (!part === !sub) return { ok: false, error: "Say the part (part_id) or the sub-assembly build, one of the two." };
    if (!(quantity > 0)) return { ok: false, error: "How many each build uses is more than zero." };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<BuildsDB>;
    const row = await addComponent(db, build.id, { ...(part ? { part_id: part } : { sub_assembly_build_id: sub }), quantity, optional: a.optional === true, ...(typeof a.use_stock === "boolean" ? { use_stock: a.use_stock } : {}), notes: str(a.notes) || null });
    return { ok: true, summary: `Added ${quantity} of it to what this build is made of.`, data: { component: row.id } };
  });
  platform().actions.registerUndo("builds.add-component", (result, uctx) => {
    const d = (result as { ok?: unknown; data?: { component?: string } } | null);
    if (d?.ok !== true || !d.data?.component) return null;
    return { action_id: "builds:remove-component", args: { component: d.data.component }, ...onBuild(uctx) };
  });
}
