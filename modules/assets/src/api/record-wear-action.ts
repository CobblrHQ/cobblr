// Count wear on a tool (assets:record-wear): the handler its manifest entry names. Wired in ./index.ts.
// A tool installed in a machine (a gripper on an arm, a nozzle on a printer)
// counts the cycles, prints and hours the machine makes while it is there, so
// a service schedule on the tool itself comes due by its own use.
import { sql, type Kysely } from "kysely";
import { platform, requireActionEntity } from "@cobblr/platform-contract";
import type { AssetsDB } from "../db.js";

const ASSET_KIND = "assets:asset";
const amount = (v: unknown) => { const n = Number(v ?? 0); return Number.isFinite(n) ? n : 0; };

/** Add use to one tool, atomically, so two machines' finishes both count. */
async function wear(db: Kysely<AssetsDB>, id: string, cycles: number, prints: number, hours: number) {
  return db.updateTable("assets_assets").set({
    metadata: sql`jsonb_set(jsonb_set(jsonb_set(coalesce(metadata, '{}'::jsonb),
      '{used_cycles}', to_jsonb(coalesce((metadata->>'used_cycles')::numeric, 0) + ${cycles})),
      '{used_prints}', to_jsonb(coalesce((metadata->>'used_prints')::numeric, 0) + ${prints})),
      '{used_hours}', to_jsonb(coalesce((metadata->>'used_hours')::numeric, 0) + ${hours}))` as never,
    updated_at: new Date(),
  }).where("id", "=", id).returning(["id", "name"]).executeTakeFirst();
}

/** A machine's recorded use wears the assets installed in it (placed in it). */
export function registerWearFromMachineUse(): void {
  platform().events.on("machines.usage.recorded", "assets", async (payload) => {
    const p = payload as { orgId?: string; machine?: { kind: string; id: string }; cycles?: unknown; prints?: unknown; hours?: unknown };
    if (!p.orgId || !p.machine) return;
    const cycles = amount(p.cycles), prints = amount(p.prints), hours = amount(p.hours);
    if (!cycles && !prints && !hours) return;
    const inside = await platform().placement.contents({ orgId: p.orgId, container: p.machine });
    const db = (await platform().tenants.getDb(p.orgId)) as Kysely<AssetsDB>;
    for (const tool of inside.filter((c) => c.kind === ASSET_KIND)) await wear(db, tool.id, cycles, prints, hours);
  });
}

export function registerRecordWearAction(): void {
  platform().actions.registerHandler("assets.record-wear", async (ctx) => {
    const record = requireActionEntity(ctx);
    const args = (ctx.args ?? {}) as { cycles?: unknown; prints?: unknown; hours?: unknown };
    const cycles = amount(args.cycles), prints = amount(args.prints), hours = amount(args.hours);
    if (!cycles && !prints && !hours) return { ok: false, error: "Say the cycles, prints or hours to count." };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<AssetsDB>;
    // One atomic update, so two machines' finishes at once both count.
    const row = await wear(db, record.id, cycles, prints, hours);
    if (!row) return { ok: false, error: "That tool is not here any more." };
    const said = [cycles ? `${cycles} cycles` : "", prints ? `${prints} prints` : "", hours ? `${hours} hours` : ""].filter(Boolean).join(", ");
    return { ok: true, assetId: row.id, cycles, prints, hours, summary: `Counted ${said} on "${row.name}".` };
  });
}
