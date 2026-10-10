import { platform, type TidyCandidate, countOf } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { InventoryDB } from "./db.js";
export function registerInventoryTidyFinders(): void {
  platform().tidy.registerFinder({ id: "inventory.warranties", module: "inventory", async find(ctx) {
    const db = await platform().tenants.getDb(ctx.orgId) as Kysely<InventoryDB>;
    const today = new Date(ctx.now.toISOString().slice(0, 10));
    const soon = new Date(today.getTime() + 30 * 86400000);
    const rows = await db.selectFrom("inventory_parts").select(["id", "name", "instance"]).where("archived", "=", false).where("lifetime_warranty", "=", false).where("warranty_expires", ">=", today).where("warranty_expires", "<=", soon).execute();
    const groups = new Map<string, typeof rows>();
    for (const r of rows) { const list = groups.get(r.instance) ?? []; list.push(r); groups.set(r.instance, list); }
    return [...groups].map(([instance, rows]): TidyCandidate => ({ id: `warranty:${instance}`, kind: "warranty-ending", records: rows.map((r) => ({ kind: instance === "inventory" ? "inventory:part" : `${instance}:item`, id: r.id, name: r.name })), action: { route: instance === "inventory" ? "/inventory" : `/instances/${instance}` }, why: `Check ${countOf(rows.length, "warranty")} ending within 30 days.`, priority: 15 }));
  } });
}
