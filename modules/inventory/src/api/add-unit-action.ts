// Add a numbered unit (inventory:add-unit): the handler its manifest entry names. Wired in ./index.ts.
// The same mint as Add unit on an item (POST /parts/:id/units): one physical
// thing, qty 1, paired to its model; the model's counted qty is not touched.
import { platform, requireActionEntity } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { InventoryDB } from "../db.js";
import { mintUnit } from "./parts.js";

export function registerAddUnitAction(): void {
  platform().actions.registerHandler("inventory.add-unit", async (ctx) => {
    const entity = requireActionEntity(ctx);
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<InventoryDB>;
    const model = await db.selectFrom("inventory_parts").select(["id", "name", "instance"]).where("id", "=", entity.id).executeTakeFirst();
    if (!model) return { ok: false, error: "That item is gone." };
    // The instance's own quantity unit (a yarn list counts skeins), as the route reads it from its config.
    const inst = (await platform().instances.list(ctx.orgId)).find((i) => i.instance_name === model.instance) as { config?: { qty_unit?: unknown } } | undefined;
    const qtyUnit = typeof inst?.config?.qty_unit === "string" && inst.config.qty_unit.trim() ? inst.config.qty_unit : null;
    const serial = typeof ctx.args?.serial_number === "string" ? ctx.args.serial_number.slice(0, 160) : undefined;
    const name = typeof ctx.args?.name === "string" && ctx.args.name.trim() ? ctx.args.name.slice(0, 160) : undefined;
    const unit = await mintUnit(db, ctx.orgId, ctx.userId, { id: model.id, name: model.name, instance: model.instance, kind: entity.kind, qtyUnit }, { ...(serial ? { serial_number: serial } : {}), ...(name ? { name } : {}) });
    return { ok: true, summary: `Added ${unit.name} as a unit of ${model.name}.`, data: { unit: unit.id, serial_number: unit.serial_number } };
  });
}
