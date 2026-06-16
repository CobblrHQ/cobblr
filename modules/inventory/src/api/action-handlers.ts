// Action handlers — the wire-engine-callable + Tier-B-invokable side of
// inventory. All GENERIC inventory capabilities (a use-case lives in a bundle +
// its app, never here):
//   - inventory.adjust-stock — wire/HTTP stock mutation; re-emits stock.changed.
//   - inventory.set-status    — set a part's metadata.status.
//   - inventory.create-item   — create one item (name + fields + location/…).
//   - inventory.create-items  — bulk create N items in one INSERT; returns ids.
//   - inventory.update-item   — set name/brand/location + MERGE metadata fields.
// (The Lego kit→parts expansion that used to live here moved to the Lego domain
//  module, bricklink-connector — it drives create-items + update-item.)

import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { InventoryDB } from "../db.js";

let registered = false;

interface AdjustStockPayload {
  partId?: string;
  delta?: number;
  reason?: string;
}

export function registerInventoryActionHandlers(): void {
  if (registered) return;
  registered = true;

  platform().actions.registerHandler("inventory.adjust-stock", async (ctx) => {
    // Args take precedence (an admin can hardwire a wire to "always
    // add 1"); otherwise we pull from the event payload.
    const args = (ctx.args as AdjustStockPayload | null) ?? {};
    const ev = (ctx.event?.payload as AdjustStockPayload | null) ?? {};
    const partId = args.partId ?? ev.partId;
    const delta = args.delta ?? ev.delta;
    const reason = args.reason ?? ev.reason ?? "wire-driven adjustment";
    if (!partId || typeof delta !== "number" || delta === 0) {
      return { ok: true, skipped: true, reason: "missing partId or delta" };
    }
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<InventoryDB>;
    const updated = await db
      .updateTable("inventory_parts")
      .set({
        qty: sql<string>`qty + ${delta}::numeric`,
        updated_at: new Date(),
      })
      .where("id", "=", partId)
      .returning(["id", "name", "qty", "min_qty"])
      .executeTakeFirst();
    if (!updated) return { ok: false, error: "part_not_found" };
    // Re-emit the stock-changed event so the existing
    // wire-of-record (inventory.stock.changed → projects.set-dep-
    // satisfied) keeps working — this action is additive, not a
    // replacement for the direct HTTP stock-adjust.
    await platform().events.emit("inventory.stock.changed", {
      orgId: ctx.orgId,
      partId: updated.id,
      delta,
      newQty: Number(updated.qty),
      reason,
    });

    // Low-stock signal — mirror the HTTP stock-adjust route (parts.ts): on a
    // DECREASE that lands at/below min_qty, fire inventory.stock.low. Without
    // this, action-driven consumption (a Build consuming components, any wire
    // that decrements) would never trip the "running low → shopping list"
    // wires — only the direct HTTP adjust did. Only on a decrease, so an
    // increase (e.g. checking an item off to restock) doesn't re-alert.
    const newQty = Number(updated.qty);
    const minQty = updated.min_qty == null ? null : Number(updated.min_qty);
    if (delta < 0 && minQty != null && minQty > 0 && newQty <= minQty) {
      await platform().events.emit("inventory.stock.low", {
        orgId: ctx.orgId,
        partId: updated.id,
        newQty,
        minQty,
      });
    }
    return {
      ok: true,
      partId: updated.id,
      delta,
      newQty: Number(updated.qty),
    };
  });

  // ─────────────────────── set-status ──────────────────────────────
  // A small, member-appropriate write: set a part's metadata.status
  // (the Lego set Built/Unbuilt/Missing-pieces field). This is the
  // canonical action a custom (Tier B) app block invokes — capability
  // -gated (`inventory:set-status`) like any other, so a worker can only
  // run it if granted. partId comes from args or the targeted entity.
  platform().actions.registerHandler("inventory.set-status", async (ctx) => {
    const args = (ctx.args as { partId?: string; status?: string } | null) ?? {};
    const partId = args.partId ?? (ctx.entity as { id?: string } | null)?.id;
    const status = typeof args.status === "string" ? args.status.trim().slice(0, 60) : undefined;
    if (!partId || !status) return { ok: false, error: "missing partId or status" };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<InventoryDB>;
    const row = await db
      .selectFrom("inventory_parts")
      .select(["metadata"])
      .where("id", "=", partId)
      .executeTakeFirst();
    if (!row) return { ok: false, error: "part_not_found" };
    const existing = (row.metadata as Record<string, unknown> | null) ?? {};
    await db
      .updateTable("inventory_parts")
      .set({
        metadata: sql`${JSON.stringify({ ...existing, status })}::jsonb` as never,
        updated_at: new Date(),
      })
      .where("id", "=", partId)
      .execute();
    return { ok: true, partId, status };
  });

  // ─────────────────────── create-item ─────────────────────────────
  // Generic item creation — the canonical write a custom (Tier B) app block
  // performs when it needs to ADD an entity (there was no invokable create
  // action before; apps could only set-status / adjust-stock). Creates an
  // inventory item in a given instance with a name + custom fields (metadata)
  // + an optional location/manufacturer/qty. Knows nothing about any specific
  // use-case — the caller composes the name + fields and decides what to make.
  // Capability-gated (`inventory:create-item`). Emits inventory.part.created so
  // wires fire as they would for an HTTP create.
  platform().actions.registerHandler("inventory.create-item", async (ctx) => {
    const a = (ctx.args as Record<string, unknown> | null) ?? {};
    // Empty → undefined so the column DEFAULT ('inventory') applies (see
    // create-items); "" would hide the row in an unreadable instance.
    const instance = typeof a.instance === "string" && a.instance.trim() ? a.instance.trim() : undefined;
    const name = typeof a.name === "string" && a.name.trim() ? a.name.trim().slice(0, 200) : "Untitled";
    const manufacturer = typeof a.manufacturer === "string" && a.manufacturer.trim() ? a.manufacturer.trim().slice(0, 120) : null;
    const locationId = typeof a.location_id === "string" && a.location_id ? a.location_id : null;
    const fields = (a.fields && typeof a.fields === "object" ? a.fields : {}) as Record<string, unknown>;
    const qty = typeof a.qty === "number" ? String(a.qty) : "1";
    const unit = typeof a.unit === "string" && a.unit.trim() ? a.unit.trim().slice(0, 30) : "each";
    const imagePath = typeof a.image_path === "string" && a.image_path ? a.image_path.slice(0, 500) : null;

    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<InventoryDB>;
    const created = await db
      .insertInto("inventory_parts")
      .values({
        name,
        qty,
        unit,
        instance,
        location_id: locationId,
        manufacturer,
        image_path: imagePath,
        metadata: sql`${JSON.stringify(fields)}::jsonb` as never,
      })
      .returning(["id", "name"])
      .executeTakeFirst();
    if (!created) return { ok: false, error: "create_failed" };

    await platform().events.emit("inventory.part.created", { orgId: ctx.orgId, partId: created.id });
    return { ok: true, item_id: created.id, name: created.name };
  });

  // ─────────────────────── create-items (bulk) ─────────────────────
  // Generic bulk create — one INSERT for N items (a kit BOM, a CSV import, a
  // batch from another module). Returns the new ids in input order so the
  // caller can wire pairings. Deliberately does NOT fan out per-item
  // inventory.part.created events (a 700-part expansion shouldn't fire 700
  // wires); a caller that needs a signal emits its own. Generic — no use-case.
  platform().actions.registerHandler("inventory.create-items", async (ctx) => {
    const a = (ctx.args as Record<string, unknown> | null) ?? {};
    const items = Array.isArray(a.items) ? (a.items as Record<string, unknown>[]) : [];
    if (items.length === 0) return { ok: true, ids: [] };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<InventoryDB>;
    const rows = items.map((o) => ({
      name: typeof o.name === "string" && o.name.trim() ? o.name.trim().slice(0, 200) : "Untitled",
      qty: typeof o.qty === "number" ? String(o.qty) : typeof o.qty === "string" && o.qty ? o.qty : "1",
      unit: typeof o.unit === "string" && o.unit.trim() ? o.unit.trim().slice(0, 30) : "each",
      // Omit when not given so the column DEFAULT ('inventory') applies —
      // forcing "" would bury the rows in an empty instance the default
      // list/detail reads (instanceOf → 'inventory') never return.
      instance: typeof o.instance === "string" && o.instance.trim() ? o.instance.trim() : undefined,
      location_id: typeof o.location_id === "string" && o.location_id ? o.location_id : null,
      manufacturer: typeof o.manufacturer === "string" && o.manufacturer.trim() ? o.manufacturer.trim().slice(0, 120) : null,
      image_path: typeof o.image_path === "string" && o.image_path ? o.image_path : null,
      metadata: sql`${JSON.stringify(o.fields && typeof o.fields === "object" ? o.fields : {})}::jsonb` as never,
    }));
    const inserted = await db.insertInto("inventory_parts").values(rows).returning(["id"]).execute();
    return { ok: true, ids: inserted.map((r) => r.id) };
  });

  // ─────────────────────── update-item ─────────────────────────────
  // Generic field update — set a part's name / brand / location and/or MERGE
  // metadata fields (e.g. mark a kit metadata.lifecycle='parted-out'). The
  // companion to create-item; lets a Tier-B app or another module edit an item
  // through inventory's public interface instead of touching the table. Generic.
  platform().actions.registerHandler("inventory.update-item", async (ctx) => {
    const a = (ctx.args as Record<string, unknown> | null) ?? {};
    const id = typeof a.id === "string" && a.id ? a.id : (ctx.entity as { id?: string } | null)?.id;
    if (!id) return { ok: false, error: "missing id" };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<InventoryDB>;
    const row = await db.selectFrom("inventory_parts").select("metadata").where("id", "=", id).executeTakeFirst();
    if (!row) return { ok: false, error: "not_found" };
    const set: Record<string, unknown> = { updated_at: new Date() };
    if (typeof a.name === "string" && a.name.trim()) set.name = a.name.trim().slice(0, 200);
    if (typeof a.manufacturer === "string") set.manufacturer = a.manufacturer.trim().slice(0, 120) || null;
    if (typeof a.location_id === "string") set.location_id = a.location_id || null;
    if (a.fields && typeof a.fields === "object") {
      const existing = (row.metadata as Record<string, unknown> | null) ?? {};
      set.metadata = sql`${JSON.stringify({ ...existing, ...(a.fields as Record<string, unknown>) })}::jsonb` as never;
    }
    await db.updateTable("inventory_parts").set(set as never).where("id", "=", id).execute();
    await platform().events.emit("inventory.part.updated", { orgId: ctx.orgId, partId: id });
    return { ok: true, id };
  });

  // ───────────────── lift-to-type (bundle-migration engine) ─────────────────
  // Generic data migration: lift each item in a SOURCE instance into a TYPE in a
  // target instance — deduped by key fields, linked via a pairing, optionally
  // converting the qty unit. This is what turns a flat single-instance bundle
  // (filament 0.3.x: one row per spool) into the type→instances model (a type +
  // its spools) when the user UPGRADES the bundle — no script, no use-case here:
  // the bundle declares the params. Idempotent: skips items already linked, so a
  // re-run (or a re-upgrade) is safe. Args: { source_instance, type_instance,
  // key_fields[], relationship_kind?, convert_qty?: { from_unit, to_unit, factor } }.
  platform().actions.registerHandler("inventory.lift-to-type", async (ctx) => {
    const a = (ctx.args as Record<string, unknown> | null) ?? {};
    const sourceInstance = typeof a.source_instance === "string" ? a.source_instance : "";
    const typeInstance = typeof a.type_instance === "string" ? a.type_instance : "";
    const keyFields = Array.isArray(a.key_fields) ? (a.key_fields as string[]) : [];
    // Additional fields to copy from the source item onto the TYPE (beyond the
    // dedup key) — the defining attributes that belong on the type, not the unit
    // (e.g. nozzle/bed temp, needs-drying). Taken from the first item of each type.
    const copyFields = Array.isArray(a.copy_fields) ? (a.copy_fields as string[]) : [];
    const rel = typeof a.relationship_kind === "string" && a.relationship_kind ? a.relationship_kind : "instance-of";
    const conv = (a.convert_qty && typeof a.convert_qty === "object" ? a.convert_qty : null) as
      | { from_unit?: string; to_unit?: string; factor?: number }
      | null;
    // Optional: scope the lift to specific source items (by id) instead of the
    // whole source instance. The "lift just this one item I created/scanned"
    // path — the bundle migration omits it (lifts everything); the create-time
    // auto-lift passes the new item's id.
    const sourceIds = Array.isArray(a.source_ids)
      ? (a.source_ids as unknown[]).filter((x): x is string => typeof x === "string")
      : null;
    if (!sourceInstance || !typeInstance || keyFields.length === 0) {
      return { ok: false, error: "missing source_instance / type_instance / key_fields" };
    }

    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<InventoryDB>;
    const NATIVE = new Set(["name", "manufacturer", "qty", "unit"]);
    const fieldVal = (row: Record<string, unknown>, f: string): string => {
      const v = NATIVE.has(f) ? row[f] : (row.metadata as Record<string, unknown> | null)?.[f];
      return v == null ? "" : String(v).trim().toLowerCase();
    };
    const keyOf = (row: Record<string, unknown>) => keyFields.map((f) => fieldVal(row, f)).join("|");

    let sourcesQ = db
      .selectFrom("inventory_parts").selectAll()
      .where("instance", "=", sourceInstance as never)
      .where("archived", "=", false);
    if (sourceIds) sourcesQ = sourcesQ.where("id", "in", sourceIds as never);
    const sources = await sourcesQ.execute();
    if (sources.length === 0) return { ok: true, types_created: 0, linked: 0, converted: 0 };

    // Dedupe against existing types so a re-run doesn't duplicate them.
    const existingTypes = await db
      .selectFrom("inventory_parts").selectAll()
      .where("instance", "=", typeInstance as never)
      .execute();
    const typeByKey = new Map<string, string>();
    for (const t of existingTypes) typeByKey.set(keyOf(t as Record<string, unknown>), t.id);

    let typesCreated = 0, linked = 0, converted = 0, toppedUp = 0;
    // Types whose copy_fields we've already ensured this run (avoid re-querying
    // for every spool of the same type).
    const toppedUpTypes = new Set<string>();
    for (const s of sources) {
      const meta = (s.metadata as Record<string, unknown> | null) ?? {};
      // Is this spool already linked to a type (from an earlier migration)?
      const pairs = await platform().pairings.findBySources({
        orgId: ctx.orgId, sourceKind: "inventory:part", sourceIds: [s.id],
        targetKind: "inventory:part", relationshipKind: rel,
      });
      let typeId: string | undefined = pairs[0]?.targetId;

      if (!typeId) {
        // Unlinked — find or create the type, link it, convert the unit.
        const k = keyOf(s as Record<string, unknown>);
        typeId = typeByKey.get(k);
        if (!typeId) {
          const typeMeta: Record<string, unknown> = {};
          for (const f of [...keyFields, ...copyFields]) if (!NATIVE.has(f) && meta[f] != null) typeMeta[f] = meta[f];
          // Prefer the item's own (user-given) name — it's the meaningful label
          // ("Royal Blue PLA"); a brand+colour+material composite is the fallback
          // (and would be ugly for filament, whose colour is a hex).
          const nameParts = [s.manufacturer, meta.color, meta.material].filter((x) => x && String(x).trim());
          const name = ((s.name && s.name.trim()) || nameParts.join(" ") || "Untitled type").slice(0, 200);
          const created = await db
            .insertInto("inventory_parts")
            .values({
              name,
              instance: typeInstance as never,
              manufacturer: s.manufacturer ?? null,
              metadata: sql`${JSON.stringify(typeMeta)}::jsonb` as never,
            })
            .returning(["id"])
            .executeTakeFirst();
          if (!created) continue;
          typeId = created.id;
          typeByKey.set(k, typeId);
          typesCreated++;
          toppedUpTypes.add(typeId); // a fresh type already carries the copy_fields
        }
        await platform().pairings.create({
          orgId: ctx.orgId, sourceKind: "inventory:part", sourceId: s.id,
          targetKind: "inventory:part", targetId: typeId, relationshipKind: rel,
          createdBy: ctx.userId,
        });
        linked++;
        if (conv?.from_unit && conv.to_unit && typeof conv.factor === "number" &&
            String(s.unit).toLowerCase() === conv.from_unit.toLowerCase()) {
          await db.updateTable("inventory_parts")
            .set({ qty: sql`(qty * ${conv.factor})` as never, unit: conv.to_unit })
            .where("id", "=", s.id)
            .execute();
          converted++;
        }
      }

      // Ensure the type carries the copy_fields. This runs for ALREADY-LINKED
      // spools too — so a second migration that introduces copy_fields (e.g.
      // moving the temps onto the type) tops up types created by an earlier
      // pass. Only fills MISSING keys, so a user's edit to the type is never
      // clobbered. Once per type per run.
      if (typeId && copyFields.length > 0 && !toppedUpTypes.has(typeId)) {
        toppedUpTypes.add(typeId);
        const add: Record<string, unknown> = {};
        for (const f of copyFields) if (!NATIVE.has(f) && meta[f] != null) add[f] = meta[f];
        if (Object.keys(add).length > 0) {
          const trow = await db.selectFrom("inventory_parts").select("metadata").where("id", "=", typeId).executeTakeFirst();
          const existing = (trow?.metadata as Record<string, unknown> | null) ?? {};
          const merged = { ...existing };
          let changed = false;
          for (const [mk, mv] of Object.entries(add)) if (merged[mk] == null) { merged[mk] = mv; changed = true; }
          if (changed) {
            await db.updateTable("inventory_parts")
              .set({ metadata: sql`${JSON.stringify(merged)}::jsonb` as never })
              .where("id", "=", typeId)
              .execute();
            toppedUp++;
          }
        }
      }
    }
    return { ok: true, types_created: typesCreated, linked, converted, topped_up: toppedUp };
  });

  // ─────────────────────── split-lot ───────────────────────────────
  // Split N units off an item's quantity into a NEW separate item, linked to
  // the same parent (so type rollups still count it). The "I entered 5 × 1kg
  // spools as one lot; now I opened one — track it on its own" move. Generic:
  // works on any inventory item with a numeric qty, in any instance — the new
  // item inherits the source's instance, fields, manufacturer, location, image,
  // and parent pairing(s). Default split = 1 (the common "open one" case); pass
  // a `quantity` arg for more. The lot must keep ≥1 — you can't split off the
  // whole lot (that would just be the single item you'd end up with).
  platform().actions.registerHandler("inventory.split-lot", async (ctx) => {
    const a = (ctx.args as { partId?: string; quantity?: number } | null) ?? {};
    const partId = a.partId ?? (ctx.entity as { id?: string } | null)?.id;
    const splitQty = typeof a.quantity === "number" && a.quantity > 0 ? a.quantity : 1;
    if (!partId) return { ok: false, error: "missing partId" };

    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<InventoryDB>;
    const src = await db
      .selectFrom("inventory_parts")
      .select([
        "id", "name", "qty", "unit", "instance",
        "manufacturer", "location_id", "image_path", "metadata",
      ])
      .where("id", "=", partId)
      .executeTakeFirst();
    if (!src) return { ok: false, error: "part_not_found" };

    const srcQty = Number(src.qty);
    if (!Number.isFinite(srcQty) || srcQty - splitQty < 1) {
      return {
        ok: false,
        error: "nothing_to_split",
        message: `The lot must keep at least 1 after the split (have ${srcQty}, splitting ${splitQty}).`,
      };
    }

    // 1. Decrement the lot.
    await db
      .updateTable("inventory_parts")
      .set({ qty: sql<string>`qty - ${splitQty}::numeric`, updated_at: new Date() })
      .where("id", "=", partId)
      .execute();

    // 2. Create the split-off item — same instance + fields, its own qty.
    const created = await db
      .insertInto("inventory_parts")
      .values({
        name: src.name,
        qty: String(splitQty),
        unit: src.unit,
        instance: src.instance as never,
        manufacturer: src.manufacturer ?? null,
        location_id: src.location_id ?? null,
        image_path: src.image_path ?? null,
        metadata: sql`${JSON.stringify((src.metadata as Record<string, unknown> | null) ?? {})}::jsonb` as never,
      })
      .returning(["id"])
      .executeTakeFirst();
    if (!created) return { ok: false, error: "create_failed" };

    // 3. Inherit the lot's parent pairing(s) (e.g. instance-of its type) so
    //    type rollups count the split-off item too.
    let linkedToType = false;
    const parents = await platform().pairings.findBySources({
      orgId: ctx.orgId, sourceKind: "inventory:part", sourceIds: [partId],
      targetKind: "inventory:part", relationshipKind: "instance-of",
    });
    for (const p of parents) {
      await platform().pairings.create({
        orgId: ctx.orgId, sourceKind: "inventory:part", sourceId: created.id,
        targetKind: "inventory:part", targetId: p.targetId, relationshipKind: "instance-of",
        createdBy: ctx.userId,
      });
      linkedToType = true;
    }

    // 4. Events: the lot's stock fell; a new item exists.
    await platform().events.emit("inventory.stock.changed", {
      orgId: ctx.orgId, partId, delta: -splitQty, newQty: srcQty - splitQty, reason: "split-lot",
    });
    await platform().events.emit("inventory.part.created", { orgId: ctx.orgId, partId: created.id });

    return { ok: true, sourceId: partId, newId: created.id, newQty: srcQty - splitQty, splitQty, linkedToType };
  });
}

