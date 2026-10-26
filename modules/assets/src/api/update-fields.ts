// How a member's edit of an asset is applied when it does not come through
// the asset page: an app's edit form, the API, Cobb (platform:update-fields).
// The same rules as PATCH /assets/:id for the fields it takes: custom fields
// cast and merged, a location change through the placement seam, its own
// history line and event. State stays out: sold or given away is a
// disposition with its own steps, not a field.

import type { Kysely } from "kysely";
import { z } from "zod";
import { AssetDate } from "./asset-date.js";
import { platform, type EntityUpdateContext, type EntityUpdateResult } from "@cobblr/platform-contract";
import { coerceMetadata, splitFieldsForUpdate, withMetadataMerged } from "@cobblr/platform-contract/entity-metadata";
import type { AssetsDB } from "../db.js";

const EditableNative = z
  .object({
    name: z.string().trim().min(1, "Give this equipment a name.").max(200),
    short_name: z.string().max(40).nullable(),
    manufacturer: z.string().max(120).nullable(),
    model: z.string().max(120).nullable(),
    type: z.string().max(120).nullable(),
    excitement: z.number().int().min(0).max(5),
    quantity: z.number().int().min(0),
    serial_number: z.string().max(160).nullable(),
    purchased_at: AssetDate,
    purchase_price_cents: z.number().int().min(0).max(10_000_000_000).nullable(),
    vendor: z.string().max(200).nullable(),
    warranty_until: AssetDate,
    last_service_at: AssetDate,
    notes: z.string().max(8_000).nullable(),
    location_id: z.string().uuid().nullable(),
    flags: z.array(z.string()),
  })
  .partial();

export const ASSET_EDITABLE_KEYS: ReadonlySet<string> = new Set(Object.keys(EditableNative.shape));

export async function updateAssetFields(ctx: EntityUpdateContext): Promise<EntityUpdateResult> {
  if ("state" in ctx.fields) return { ok: false, error: "state cannot be edited here: sold or given away is its own step on the asset." };
  const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<AssetsDB>;
  const before = await db.selectFrom("assets_assets").selectAll().where("id", "=", ctx.id).executeTakeFirst();
  if (!before) return { ok: false, error: "That asset is no longer there." };
  const kind = before.instance === "assets" ? "assets:asset" : `${before.instance}:item`;

  let split: Awaited<ReturnType<typeof splitFieldsForUpdate>>;
  try {
    split = await splitFieldsForUpdate(ctx.orgId, kind, ctx.id, ctx.fields, ASSET_EDITABLE_KEYS);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  const parsed = EditableNative.strict().safeParse(split.native);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, error: `${first?.path.join(".") || "A field"}: ${first?.message ?? "not a valid value"}` };
  }
  const { location_id: locationId, ...rest } = parsed.data;
  if (!Object.keys(parsed.data).length && !Object.keys(split.custom).length) return { ok: false, error: "Nothing to change." };

  const smNames = await platform().entities.serverManagedFields(ctx.orgId, kind);
  const set: Record<string, unknown> = { ...rest, updated_at: new Date() };
  if (Array.isArray(set.flags)) set.flags = JSON.stringify(set.flags);
  if (Object.keys(split.custom).length) set.metadata = split.custom;
  await db
    .updateTable("assets_assets")
    .set(withMetadataMerged(set, smNames) as never)
    .where("id", "=", ctx.id)
    .execute();

  if (locationId !== undefined) {
    const containee = { kind: "assets:asset", id: ctx.id };
    try {
      if (locationId) await platform().placement.place({ orgId: ctx.orgId, containee, container: { kind: "core-locations:location", id: locationId } });
      else await platform().placement.remove({ orgId: ctx.orgId, containee });
    } catch {
      await db.updateTable("assets_assets").set({ location_id: locationId ?? null } as never).where("id", "=", ctx.id).execute();
    }
  }

  await platform().activity.log({
    orgId: ctx.orgId,
    userId: ctx.userId,
    action: "asset_updated",
    ref: { module: "assets", entityType: "asset", entityId: ctx.id },
    diff: Object.keys(split.custom).length ? { ...parsed.data, metadata: split.custom } : parsed.data,
    before,
  });
  const after = await db.selectFrom("assets_assets").selectAll().where("id", "=", ctx.id).executeTakeFirst();
  await platform().events.emit("assets.asset.updated", {
    orgId: ctx.orgId,
    assetId: ctx.id,
    before: { ...before, ...coerceMetadata((before as { metadata?: unknown }).metadata) },
    after: { ...before, ...parsed.data, ...coerceMetadata((after as { metadata?: unknown } | undefined)?.metadata) },
  });
  return { ok: true, summary: `Saved ${before.name}.`, changed: [...Object.keys(parsed.data), ...Object.keys(split.custom)] };
}
