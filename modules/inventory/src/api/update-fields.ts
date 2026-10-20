// How a member's edit of a part is applied when it does not come through the
// part page: an app's edit form, the API, Cobb (platform:update-fields). The
// same rules as PATCH /parts/:id for the fields it takes (a name of real
// words, a custom field cast to its type, its own history line and event),
// and nothing about stock: a count moves through the stock actions, which
// keep the ledger, so qty/unit/archived are refused here with the way round.

import type { Kysely } from "kysely";
import { z } from "zod";
import { platform, type EntityUpdateContext, type EntityUpdateResult } from "@cobblr/platform-contract";
import { recordName } from "@cobblr/platform-contract/record-name";
import { coerceMetadata } from "@cobblr/platform-contract/entity-metadata";
import { splitFieldsForUpdate } from "@cobblr/platform-contract/entity-metadata";
import { applyJsonbMerge } from "@cobblr/platform-contract/jsonb-merge";
import type { InventoryDB } from "../db.js";
import { holdingsCtxForPart, spreadIdentity } from "./holdings.js";
import { PART_NAME_MAX } from "../part-limits.js";

const STOCK_FIELDS = ["qty", "unit", "approximate_qty", "archived", "state"] as const;

const EditableNative = z
  .object({
    name: z.string().min(1).max(PART_NAME_MAX),
    description: z.string().max(8_000).nullable(),
    category_id: z.string().uuid().nullable(),
    location_id: z.string().uuid().nullable(),
    cost: z.number().nonnegative().nullable(),
    min_qty: z.number().nonnegative().nullable(),
    manufacturer: z.string().max(120).nullable(),
    supplier_url: z.string().url().max(500).nullable(),
    notes: z.string().max(8_000).nullable(),
    serial_number: z.string().max(160).nullable(),
    model_number: z.string().max(160).nullable(),
    warranty_expires: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    lifetime_warranty: z.boolean(),
    warranty_details: z.string().max(2_000).nullable(),
    insured: z.boolean(),
  })
  .partial();

export const PART_EDITABLE_KEYS: ReadonlySet<string> = new Set(Object.keys(EditableNative.shape));

export async function updatePartFields(ctx: EntityUpdateContext): Promise<EntityUpdateResult> {
  const stock = STOCK_FIELDS.filter((k) => k in ctx.fields);
  if (stock.length) {
    return { ok: false, error: `${stock.join(", ")} cannot be edited here: a count changes through the stock actions, which keep the ledger.` };
  }
  const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<InventoryDB>;
  const before = await db.selectFrom("inventory_parts").selectAll().where("id", "=", ctx.id).executeTakeFirst();
  if (!before) return { ok: false, error: "That part is no longer there." };
  const kind = before.instance === "inventory" ? "inventory:part" : `${before.instance}:item`;

  let split: Awaited<ReturnType<typeof splitFieldsForUpdate>>;
  try {
    split = await splitFieldsForUpdate(ctx.orgId, kind, ctx.id, ctx.fields, PART_EDITABLE_KEYS);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  const parsed = EditableNative.strict().safeParse(split.native);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, error: `${first?.path.join(".") || "A field"}: ${first?.message ?? "not a valid value"}` };
  }
  const native: Record<string, unknown> = parsed.data;
  if ("name" in native) {
    const built = recordName(native.name as string);
    if (!built) return { ok: false, error: "Say what it is called." };
    native.name = built;
  }
  if (!Object.keys(native).length && !Object.keys(split.custom).length) return { ok: false, error: "Nothing to change." };

  const writer = await platform().entities.getWriter(ctx.orgId, "inventory:part");
  if (!writer?.mergeMetadata) return { ok: false, error: "Parts cannot be changed here right now." };
  if (Object.keys(native).length) await writer.update(ctx.orgId, ctx.id, native);
  if (Object.keys(split.custom).length) await writer.mergeMetadata(ctx.orgId, ctx.id, split.custom);

  const holdings = await holdingsCtxForPart(ctx.orgId, ctx.userId, ctx.id);
  if (holdings) await spreadIdentity(holdings, ctx.id, native);

  await platform().activity.log({
    orgId: ctx.orgId,
    userId: ctx.userId,
    action: "part_updated",
    ref: { module: "inventory", entityType: "part", entityId: ctx.id },
    diff: Object.keys(split.custom).length ? { ...native, metadata: split.custom } : native,
    before,
  });
  const beforeMeta = coerceMetadata((before as { metadata?: unknown }).metadata);
  await platform().events.emit("inventory.part.updated", {
    orgId: ctx.orgId,
    partId: ctx.id,
    before: { ...before, ...beforeMeta },
    after: { ...before, ...native, ...applyJsonbMerge(beforeMeta, split.custom) },
  });
  return { ok: true, summary: `Saved ${before.name}.`, changed: [...Object.keys(native), ...Object.keys(split.custom)] };
}
