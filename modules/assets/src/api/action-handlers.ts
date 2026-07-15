// assets action handlers — the inbound TELEMETRY surface.
//
// assets:update-fields turns "a device can POST to Cobblr" into "an asset's
// fields update themselves." A wire binds an event (canonically
// core-integrations.inbound.received with target "none") to this action with
// template-rendered args — e.g. an OBD dongle / Home Assistant / telematics
// webhook POSTs { vehicle: "Honda Civic", odometer: 48650 } and the wire
// invokes us with { asset: "{{event.body.vehicle}}",
// mileage: "{{event.body.odometer}}" }. We find the asset and merge the
// values into its metadata. Coordinate-not-control's read side: devices
// report state; Cobblr keeps the record (and maintenance schedules,
// computed fields, and calendar entries react to it).
//
// Arg shape mirrors digifab:run-command: `asset` is the one control arg
// (id or case-insensitive name); EVERY other arg is a metadata field
// update. Metadata only — native columns (name, status, …) are
// deliberately not writable from a wire.

import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { AssetsDB } from "../db.js";

let registered = false;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolve the `asset` arg to a row: exact id first, then case-insensitive
 *  name match (a bundle-seeded wire can't know runtime UUIDs — it references
 *  the asset the way the payload names it). Ambiguous name → null + reason. */
async function resolveAssetRef(
  db: Kysely<AssetsDB>,
  ref: string,
): Promise<{ id: string; name: string; metadata: unknown } | { error: string }> {
  if (UUID_RE.test(ref)) {
    const byId = await db
      .selectFrom("assets_assets")
      .select(["id", "name", "metadata"])
      .where("id", "=", ref)
      .executeTakeFirst();
    if (byId) return byId;
  }
  const byName = await db
    .selectFrom("assets_assets")
    .select(["id", "name", "metadata"])
    .where(sql<boolean>`lower(name) = lower(${ref})`)
    .execute();
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) return { error: "ambiguous_asset_name" };
  return { error: "asset_not_found" };
}

/** Wire args arrive as template-rendered STRINGS; a numeric field (mileage)
 *  should land as a number so sorting/computed fields behave. */
function coerce(v: unknown): unknown {
  if (typeof v === "string" && v.trim() !== "" && /^-?\d+(\.\d+)?$/.test(v.trim())) {
    return Number(v.trim());
  }
  return v;
}

export function registerActionHandlers(): void {
  if (registered) return;
  registered = true;

  // ───────────── field-to-location (bundle-migration engine) ─────────────
  // The assets mirror of inventory:field-to-location. Retire a bundle's bespoke
  // place field (e.g. home-maintenance's "location" text field) into the
  // platform's canonical Location: for each asset in an instance with a value,
  // find-or-create a matching Location AREA (via the core-locations WRITER seam)
  // and file the asset into it, then clear the field. Idempotent + safe: never
  // invents a place, never overwrites an already-filed asset, re-uses a same-named
  // area. Args: { field, instance }.
  platform().actions.registerHandler("assets.field-to-location", async (ctx) => {
    const a = (ctx.args as Record<string, unknown> | null) ?? {};
    const field = typeof a.field === "string" ? a.field : "";
    const instance = typeof a.instance === "string" ? a.instance : "";
    if (!field || !instance) return { ok: false, error: "missing field / instance" };

    const writer = platform().entities.getWriter("core-locations:location");
    if (!writer) return { ok: false, error: "core-locations not available" };

    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<AssetsDB>;
    const rows = await db
      .selectFrom("assets_assets")
      .select(["id", "location_id", "metadata"])
      .where("instance", "=", instance as never)
      .execute();

    const existing = writer.listForMatch ? await writer.listForMatch(ctx.orgId) : [];
    const areaByName = new Map<string, string>();
    for (const l of existing) areaByName.set(l.name.trim().toLowerCase(), l.id);

    let filed = 0;
    let areasCreated = 0;
    for (const r of rows) {
      const meta = (r.metadata as Record<string, unknown> | null) ?? {};
      if (!(field in meta)) continue; // already migrated / never had it → skip
      const raw = meta[field];
      const name = raw == null ? "" : String(raw).trim();
      const nextMeta = { ...meta };
      delete nextMeta[field];
      const patch: Record<string, unknown> = { metadata: sql`${JSON.stringify(nextMeta)}::jsonb` as never };
      if (!r.location_id && name) {
        const key = name.toLowerCase();
        let locId = areaByName.get(key);
        if (!locId) {
          locId = await writer.create(ctx.orgId, { name, kind: "area" });
          areaByName.set(key, locId);
          areasCreated++;
        }
        patch.location_id = locId;
        filed++;
      }
      await db.updateTable("assets_assets").set(patch as never).where("id", "=", r.id).execute();
    }
    return { ok: true, filed, areas_created: areasCreated };
  });

  platform().actions.registerHandler("assets.update-fields", async (ctx) => {
    const args = (ctx.args as Record<string, unknown> | null) ?? {};
    const assetRef = typeof args.asset === "string" ? args.asset.trim() : "";
    // Everything except the control arg is a metadata field update.
    const { asset: _a, ...fields } = args;
    const updates: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      // A template whose token didn't resolve renders to "" — skip it
      // rather than blanking a real value (a payload missing one field
      // shouldn't erase what we know).
      if (v === "" || v === null || v === undefined) continue;
      updates[k] = coerce(v);
    }
    if (!assetRef) return { ok: false, skipped: true, reason: "missing `asset` arg" };
    if (Object.keys(updates).length === 0) {
      return { ok: false, skipped: true, reason: "no field values to apply" };
    }

    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<AssetsDB>;
    const found = await resolveAssetRef(db, assetRef);
    if ("error" in found) return { ok: false, error: found.error, asset: assetRef };

    await db
      .updateTable("assets_assets")
      .set({
        // Overlay only THIS action's keys, DB-side, against the live row — an
        // asset's metadata is multi-writer (user PATCH, integrations sync, scan
        // confirm), and a full-replace from a read snapshot dropped their keys.
        metadata: sql`coalesce(metadata, '{}'::jsonb) || ${JSON.stringify(updates)}::jsonb` as never,
        updated_at: new Date(),
      })
      .where("id", "=", found.id)
      .execute();

    await platform().activity.log({
      orgId: ctx.orgId,
      userId: ctx.userId ?? null,
      action: "asset_fields_updated",
      ref: { module: "assets", entityType: "asset", entityId: found.id },
      diff: { via: "wire", event: ctx.event?.name ?? null, updates },
    });

    return { ok: true, asset_id: found.id, asset_name: found.name, updated: updates };
  });
}
