import { createHash } from "node:crypto";
import { Router } from "express";
import { sql, type Kysely } from "kysely";
import { z } from "zod";
import { ActionRefusal, platform } from "@cobblr/platform-contract";
import { normaliseActionResult } from "@cobblr/platform-contract/action-result";
import { MslSchema, initialStorage } from "../stock-storage.js";
import { instanceOf, tenantContext, sessionUser, type InventoryDB } from "../db.js";
import { familiesOf } from "./families.js";
import { stockMoved } from "./stock-moved.js";
import { recordConsumption } from "./stock-ledger.js";
import { asyncHandler, badBody, requireCapability } from "./util.js";

const Receive = z.object({
  instance: z.string().min(1).max(80).optional(),
  code: z.string().min(1).max(4096),
  receipt_key: z.string().min(1).max(120).optional(),
  partId: z.string().uuid().optional(),
  quantity: z.number().int().positive().max(999_999_999).optional(),
  identity: z.string().trim().min(1).max(200).optional(),
  fields: z.record(z.union([z.string().max(500), z.number().finite(), z.boolean(), z.null()])).default({}),
  location_id: z.string().uuid().nullable().optional(),
  packaging: z.enum(["reel", "cut tape", "tray", "tube"]).default("reel"),
  storage: z.enum(["sealed", "dry", "open"]).default("sealed"),
  exposed_hours: z.number().finite().nonnegative().max(1_000_000).default(0),
});

export const packageReceivingRouter = Router({ mergeParams: true });
// UI-SCREEN: /instances/<collection> through ReceivePackage and the action door
// AI-REACH: action inventory:receive-package
packageReceivingRouter.post("/receive-package", asyncHandler(async (req, res) => {
  if (!await requireCapability(req, res, "inventory:receive-package")) return;
  const parsed = Receive.safeParse(req.body);
  if (!parsed.success) return void badBody(res, parsed.error);
  const instance = instanceOf(req);
  const result = normaliseActionResult(await platform().actions.invoke("inventory:receive-package", {
    orgId: tenantContext(req).org.id, userId: sessionUser(req).id, args: { ...parsed.data, instance },
    event: { name: null, payload: {}, actor: { user_id: sessionUser(req).id, display_name: null, auth_method: "session" }, timestamp: new Date().toISOString(), trigger_type: "user-invoked" },
  }), "inventory.receive-package");
  if (!result.ok) throw new ActionRefusal(typeof result.error === "string" ? result.error : "This package could not be received.");
  res.json(result.data);
}));

export function registerPackageReceiving() {
  platform().actions.registerHandler("inventory.receive-package", async ctx => {
    const parsed = Receive.safeParse(ctx.args);
    if (!parsed.success) throw new ActionRefusal("Scan the package and choose its collection.");
    const p = parsed.data;
    const families = await familiesOf(ctx.orgId);
    const fam = families.find(f => f.child === p.instance || f.parent === p.instance);
    if (!fam) throw new ActionRefusal("Choose a collection with a type and its packages.");
    const cfg = (await platform().instances.configOf(ctx.orgId, fam.child)) ?? {};
    const receiveCfg = z.object({ identity_field: z.string().min(1), storage_tracking: z.boolean().default(false) }).safeParse(cfg.package_receiving);
    if (!receiveCfg.success) throw new ActionRefusal("This collection has no package receiving configured.");
    const decoded = normaliseActionResult(await platform().actions.invoke("core-scan:decode-identifier", { ...ctx, entity: undefined, args: { code: p.code } }), "core-scan.decode-identifier");
    if (!decoded.ok) throw new ActionRefusal("The label could not be decoded.");
    const details = decoded.data as { outcome?: string; fields?: Record<string, unknown> } | undefined;
    if (!details?.fields || details.outcome === "miss" || details.outcome === "unavailable") throw new ActionRefusal("This label is not readable. Scan its 2D package code again.");
    const fields = { ...details.fields, ...p.fields };
    if (fields.msl != null && fields.msl !== "" && !MslSchema.safeParse(fields.msl).success) throw new ActionRefusal("Choose a valid MSL from the part's manufacturer data.");
    if (fields.attrition_pct != null && !z.number().finite().min(0).max(100).safeParse(fields.attrition_pct).success) throw new ActionRefusal("Give an attrition percentage between 0 and 100.");
    const identityField = receiveCfg.data.identity_field;
    const identity = p.identity ?? fields[identityField];
    if (typeof identity !== "string" || !identity.trim()) throw new ActionRefusal("Confirm the manufacturer part number before receiving.");
    fields[identityField] = identity.trim();
    const quantity = z.number().int().positive().max(999_999_999).safeParse(p.quantity ?? details.fields.quantity);
    if (!quantity.success) throw new ActionRefusal("Confirm a positive whole-number package quantity before receiving.");
    const manufacturer = typeof fields.manufacturer === "string" ? fields.manufacturer.trim() : null;
    const rawCode = p.code.replace(/^\]d[12]/, "");
    const receiptKey = createHash("sha256").update(`${fam.child}\0${p.receipt_key ?? rawCode}`).digest("hex");
    const labelHash = createHash("sha256").update(rawCode).digest("hex");
    const db = await platform().tenants.getDb(ctx.orgId) as Kysely<InventoryDB>;
    const received = await db.transaction().execute(async trx => {
      await sql`select pg_advisory_xact_lock(hashtextextended(${`receipt:${receiptKey}`}, 0))`.execute(trx);
      await sql`select pg_advisory_xact_lock(hashtextextended(${`${fam.parent}:${identity.toLowerCase()}`}, 0))`.execute(trx);
      const prior = await trx.selectFrom("inventory_package_receipts").selectAll().where("receipt_key", "=", receiptKey).executeTakeFirst();
      if (prior) {
        const type = await trx.selectFrom("inventory_parts").select(["metadata"]).where("id", "=", prior.type_id).executeTakeFirstOrThrow();
        if (prior.label_hash !== labelHash || String(type.metadata[identityField]).toLowerCase() !== identity.toLowerCase() || prior.quantity !== quantity.data || (p.partId && p.partId !== prior.part_id)) throw new ActionRefusal("This receipt key already belongs to a different package. Check it before receiving again.");
        return { part_id: prior.part_id, type_id: prior.type_id, quantity: prior.quantity, already_received: true, type_created: false, newQty: 0, minQty: null };
      }
      let query = trx.selectFrom("inventory_parts").selectAll().where("instance", "=", fam.parent).where("archived", "=", false)
        .where(sql<boolean>`lower(metadata->>${identityField}) = ${identity.toLowerCase()}`);
      if (manufacturer) query = query.where(sql<boolean>`lower(coalesce(manufacturer, '')) = ${manufacturer.toLowerCase()}`);
      const candidates = await query.forUpdate().execute();
      if (candidates.length > 1) throw new ActionRefusal("Several manufacturers use this part number. Confirm the manufacturer before receiving.");
      let type = candidates[0];
      const typeCreated = !type;
      const shared: Record<string, unknown> = {};
      for (const key of [identityField, ...fam.keyFields, ...fam.copyFields]) if (key !== "manufacturer" && fields[key] != null) shared[key] = fields[key];
      if (!type) type = await trx.insertInto("inventory_parts").values({ instance: fam.parent, name: identity.trim(), manufacturer, qty: "0", unit: "each", metadata: shared }).returningAll().executeTakeFirstOrThrow();
      if (!typeCreated) {
        const existingMetadata = type.metadata;
        const confirmed = Object.fromEntries(Object.entries(shared).filter(([key]) => existingMetadata[key] == null || existingMetadata[key] === ""));
        if (Object.keys(confirmed).length) type = await trx.updateTable("inventory_parts").set({ metadata: { ...type.metadata, ...confirmed }, updated_at: new Date() }).where("id", "=", type.id).returningAll().executeTakeFirstOrThrow();
      }
      let part;
      if (p.partId) {
        part = await trx.selectFrom("inventory_parts").selectAll().where("id", "=", p.partId).where("instance", "=", fam.child).where("archived", "=", false).forUpdate().executeTakeFirst();
        if (!part || String(part.metadata[identityField]).toLowerCase() !== identity.toLowerCase() || (part.metadata.lot_code ?? "") !== (fields.lot_code ?? "") || (part.metadata.date_code ?? "") !== (fields.date_code ?? "") || (part.manufacturer ?? "") !== (type.manufacturer ?? "")) throw new ActionRefusal("Top up only a package of the same part, manufacturer, lot and date code. Keep different lots in separate packages.");
        if (part.metadata.tracked_by) throw new ActionRefusal("This count is kept by another tracker.");
        await trx.updateTable("inventory_parts").set({ qty: sql<string>`qty + ${quantity.data}::numeric`, updated_at: new Date() }).where("id", "=", part.id).execute();
      } else {
        const metadata: Record<string, unknown> = { ...type.metadata, ...fields, packaging: p.packaging };
        delete metadata.quantity;
        part = await trx.insertInto("inventory_parts").values({ instance: fam.child, name: type.name, manufacturer: type.manufacturer, qty: String(quantity.data), unit: typeof cfg.qty_unit === "string" ? cfg.qty_unit : "each", location_id: p.location_id ?? null, metadata }).returningAll().executeTakeFirstOrThrow();
        if (receiveCfg.data.storage_tracking) await trx.insertInto("inventory_stock_storage").values({ part_id: part.id, state: { ...initialStorage(new Date()), mode: p.storage, exposed_ms: p.exposed_hours * 3_600_000 } }).execute();
      }
      await trx.insertInto("inventory_package_receipts").values({ receipt_key: receiptKey, label_hash: labelHash, part_id: part.id, type_id: type.id, quantity: quantity.data }).execute();
      await recordConsumption(trx, { partId: part.id, delta: quantity.data, reason: "Package received", sourceKind: "inventory:package-receipt", sourceId: receiptKey, byUser: ctx.userId ?? null });
      return { part_id: part.id, type_id: type.id, quantity: quantity.data, already_received: false, type_created: typeCreated, newQty: p.partId ? Number(part.qty) + quantity.data : quantity.data, minQty: part.min_qty == null ? null : Number(part.min_qty) };
    });
    await platform().pairings.create({ orgId: ctx.orgId, sourceKind: "inventory:part", sourceId: received.part_id, targetKind: "inventory:part", targetId: received.type_id, relationshipKind: fam.rel, createdBy: ctx.userId ?? null });
    if (!p.partId && p.location_id) await platform().placement.place({ orgId: ctx.orgId, containee: { kind: "inventory:part", id: received.part_id }, container: { kind: "core-locations:location", id: p.location_id } });
    if (!received.already_received) {
      if (received.type_created) await platform().activity.log({ orgId: ctx.orgId, userId: ctx.userId ?? null, action: "part_created", ref: { module: "inventory", entityType: "part", entityId: received.type_id }, diff: { name: identity } });
      await platform().activity.log({ orgId: ctx.orgId, userId: ctx.userId ?? null, action: p.partId ? "part_restocked" : "part_created", ref: { module: "inventory", entityType: "part", entityId: received.part_id }, diff: { name: identity, qty: quantity.data } });
      await stockMoved(db, ctx.orgId, { partId: received.part_id, delta: received.quantity, newQty: received.newQty, minQty: received.minQty, reason: "Package received", ledger: false });
      if (!p.partId) await platform().events.emit("inventory.part.created", { orgId: ctx.orgId, partId: received.part_id });
      // The label names who sold it and the buyer's PO, so whoever recorded the
      // order can mark its line received without a second, manual step.
      await platform().events.emit("inventory.package.received", {
        orgId: ctx.orgId, receiptKey, partId: received.part_id, typeId: received.type_id, mpn: identity.trim(), manufacturer, quantity: received.quantity,
        distributor: typeof fields.distributor === "string" ? fields.distributor : null,
        purchaseOrder: typeof fields.purchase_order === "string" ? fields.purchase_order : null,
        receivedBy: ctx.userId ?? null,
      });
    }
    return { ok: true, changed: !received.already_received, data: received };
  });
}
