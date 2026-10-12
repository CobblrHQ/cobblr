import { amountOf, centsFromAmount, fieldCurrency } from "@cobblr/platform-contract/money";
import { fieldDay } from "@cobblr/platform-contract/field-day";
import { Router } from "express";
import { z } from "zod";
import { sql } from "kysely";
import { mergeRowMetadata, platform } from "@cobblr/platform-contract";
import { DISPOSITION_KEY, dispositionOf, readRecordDisposition } from "@cobblr/platform-contract/disposition";
import { pagedAnswer, readListPage, TOTAL_COLUMN } from "@cobblr/platform-contract/list-page";
import { instanceOf, sessionUser, tenantContext, tenantDb } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { routeUnknownToMetadata, refuseUnknownFields, coerceMetadata, withMetadataMerged } from "@cobblr/platform-contract/entity-metadata";

export const assetsRouter = Router({ mergeParams: true });

// Block the read-only `guest` role from every mutating request on this
// router (covers both the direct mount and the instance-items dispatch
// path). Finer per-action roles can layer on top. (Audit 2026-06-26 P0 #1.)
assetsRouter.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
  }
  next();
});

const AssetCreate = z.object({
  name: z.string().min(1).max(200),
  short_name: z.string().max(40).nullable().optional(),
  manufacturer: z.string().max(120).nullable().optional(),
  model: z.string().max(120).nullable().optional(),
  type: z.string().max(120).nullable().optional(),
  state: z.string().max(40).optional(), // none-refused-ok: a column of this name is NOT NULL, so a null stays refused here
  excitement: z.number().int().min(0).max(5).optional(), // none-refused-ok: a column of this name is NOT NULL, so a null stays refused here
  quantity: z.number().int().min(0).optional(), // none-refused-ok: a column of this name is NOT NULL, so a null stays refused here
  serial_number: z.string().max(160).nullable().optional(),
  purchased_at: z.string().nullable().optional(),
  purchase_price_cents: z.number().int().min(0).max(10_000_000_000).nullable().optional(),
  vendor: z.string().max(200).nullable().optional(),
  warranty_until: z.string().nullable().optional(),
  last_service_at: z.string().nullable().optional(),
  image_path: z.string().max(500).nullable().optional(),
  notes: z.string().max(8_000).nullable().optional(),
  location_id: z.string().uuid().nullable().optional(),
  flags: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const ASSET_NATIVE_KEYS = new Set(Object.keys(AssetCreate.shape));

/**
 * `flags` is a jsonb ARRAY column, and node-pg renders a JS array as a POSTGRES
 * array literal ({a,b}) - which jsonb rejects. Creating or updating an asset
 * with any non-empty flags therefore failed outright with "Malformed identifier
 * or value" (reproduced against a live workspace, 2026-08-01); an empty array
 * silently stored as `{}`, an empty OBJECT, rather than `[]`.
 *
 * Passing undefined through untouched matters: a PATCH that does not mention
 * flags must not rewrite them.
 */
const jsonbArray = (v: unknown): unknown => (Array.isArray(v) ? JSON.stringify(v) : v);
const AssetUpdate = AssetCreate.partial();

/** The kind these rows are: an instance's items, or plain assets. */
const kindOf = (req: Parameters<typeof instanceOf>[0]): string => (instanceOf(req) === "assets" ? "assets:asset" : `${instanceOf(req)}:item`);

// AI-REACH: exempt — dashboard-only aggregate; Cobb reads the register.
assetsRouter.get("/dashboard", asyncHandler(async (req, res) => {
  const db = tenantDb(req);
  const rows = await db.selectFrom("assets_assets")
    .select(["state", sql<number>`count(*)::int`.as("total")])
    .where("instance", "=", instanceOf(req))
    .where("archived_at", "is", null)
    .groupBy("state").orderBy("state").execute();
  res.json({ total: rows.reduce((n, r) => n + r.total, 0), states: rows.map((r) => ({ state: r.state, count: r.total })) });
}));

assetsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    // The register is what you have: archived things only on ?archived=1.
    const archived = req.query.archived === "1" || req.query.archived === "true";
    const page = readListPage(req.query);
    const rows = await db
      .selectFrom("assets_assets")
      .selectAll()
      .select(sql<string>`count(*) over()`.as(TOTAL_COLUMN))
      .where("instance", "=", instanceOf(req))
      .where("archived_at", archived ? "is not" : "is", null)
      .orderBy("name")
      .orderBy("id")
      .limit(page.limit)
      .offset(page.offset)
      .execute();
    // Put away, sold and given away are counted apart: what the register cost
    // is what you still have, over every asset of it, not the page shown.
    const put = await db
      .selectFrom("assets_assets")
      .select(() => [
        sql<string>`count(*) filter (where archived_at is not null)`.as("n"),
      ])
      .where("instance", "=", instanceOf(req))
      .executeTakeFirst();
    const main = await platform().money.currency(tenantContext(req).org.id);
    const priced = await db.selectFrom("assets_assets").select(["purchase_price_cents", "metadata", "purchased_at", "created_at"])
      .where("instance", "=", instanceOf(req)).where("archived_at", "is", null).where("purchase_price_cents", "is not", null).execute();
    const total = await platform().money.total(tenantContext(req).org.id, priced.map((r) => ({
      value: { amount: amountOf(r.purchase_price_cents as import("@cobblr/platform-contract/money").Cents), currency: fieldCurrency(r.metadata, "purchase_price_cents", main) },
      day: fieldDay(r.purchased_at) || fieldDay(r.created_at) || "",
    })), main);
    const answer = pagedAnswer(rows, page);
    // Person and relation fields read as names (assigned_to_label).
    res.json({
      ...answer,
      items: await platform().entities.withFieldLabels(tenantContext(req).org.id, kindOf(req), answer.items),
      archived_count: Number(put?.n ?? 0),
      paid_total_cents: centsFromAmount(total.amount),
      money_total: total,
    });
  }),
);

assetsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const db = tenantDb(req);
    const row = await db
      .selectFrom("assets_assets")
      .selectAll()
      .where("id", "=", id)
      .where("instance", "=", instanceOf(req))
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "asset not found" } });
      return;
    }
    const [labelled] = await platform().entities.withFieldLabels(tenantContext(req).org.id, kindOf(req), [row as Record<string, unknown>]);
    res.json(labelled);
  }),
);

assetsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    await refuseUnknownFields(req, req.body, ASSET_NATIVE_KEYS, "assets:asset");
    const routed = routeUnknownToMetadata(req.body, ASSET_NATIVE_KEYS);
    const parsed = AssetCreate.safeParse(routed);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    // Create-then-place: location rides the placement seam
    // (placement-cutover-plan step 1); place() mirrors the legacy column.
    const { location_id: createLocationId, ...createRest } = parsed.data;
    const inserted = await db
      .insertInto("assets_assets")
      .values({
        ...createRest,
        instance: instanceOf(req),
        flags: jsonbArray(parsed.data.flags ?? []),
        metadata: { ...parsed.data.metadata, ...(parsed.data.purchase_price_cents == null ? {} : { money_currencies: { ...((parsed.data.metadata?.money_currencies as Record<string, string>) || {}), purchase_price_cents: fieldCurrency(parsed.data.metadata, "purchase_price_cents", await platform().money.currency(ctx.org.id)) } }) },
      } as never)
      .returningAll()
      .executeTakeFirstOrThrow();
    if (createLocationId) {
      try {
        await platform().placement.place({
          orgId: ctx.org.id,
          containee: { kind: "assets:asset", id: inserted.id },
          container: { kind: "core-locations:location", id: createLocationId },
        });
        (inserted as { location_id?: string | null }).location_id = createLocationId;
      } catch {
        await db.updateTable("assets_assets").set({ location_id: createLocationId }).where("id", "=", inserted.id).execute();
        (inserted as { location_id?: string | null }).location_id = createLocationId;
      }
    }
    await platform().activity.log({
      orgId: ctx.org.id,
      userId: sessionUser(req).id,
      action: "asset_created",
      ref: { module: "assets", entityType: "asset", entityId: inserted.id },
      diff: { name: parsed.data.name },
    });
    platform().events.emit("assets.asset.created", {
      orgId: ctx.org.id,
      assetId: inserted.id,
    });
    res.status(201).json(inserted);
  }),
);

assetsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    await refuseUnknownFields(req, req.body, ASSET_NATIVE_KEYS, "assets:asset");
    const routed = routeUnknownToMetadata(req.body, ASSET_NATIVE_KEYS);
    const parsed = AssetUpdate.safeParse(routed);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);

    // Read the current row FIRST — the before-image for the change event AND
    // the source of truth for server-managed fields (metadata is written
    // wholesale; a stale client value must not clobber a server-stamped one).
    // Same pattern as inventory's part PATCH.
    const before = await db
      .selectFrom("assets_assets")
      .selectAll()
      .where("id", "=", id)
      .where("instance", "=", instanceOf(req))
      .executeTakeFirst();
    if (!before) {
      res.status(404).json({ error: { code: "not_found", message: "asset not found" } });
      return;
    }

    const smNames = await platform().entities.serverManagedFields(ctx.org.id, "assets:asset");
    const beforeMeta = coerceMetadata((before as { metadata?: unknown }).metadata);

    // Location changes ride the placement seam (placement-cutover-plan
    // step 1) instead of the column write; parsed.data stays intact so the
    // activity diff and the change-event bags still carry the transition.
    const { location_id: patchLocationId, ...patchRest } = parsed.data;
    if (patchRest.flags !== undefined) {
      (patchRest as Record<string, unknown>).flags = jsonbArray(patchRest.flags);
    }
    const updated = await db
      .updateTable("assets_assets")
      // The custom fields MERGE into the live row: a partial edit never
      // replaces the bag (withMetadataMerged, #3625).
      .set(withMetadataMerged({ ...patchRest, updated_at: new Date() } as Record<string, unknown>, smNames) as never)
      .where("id", "=", id)
      .where("instance", "=", instanceOf(req))
      .returningAll()
      .executeTakeFirst();
    if (!updated) {
      res.status(404).json({ error: { code: "not_found", message: "asset not found" } });
      return;
    }
    // The State picker and "No longer mine" are one fact: picking sold or given
    // away puts the asset away (out of the register and its total), and
    // picking a state it is still yours in brings back one that left that way.
    if (parsed.data.state !== undefined && parsed.data.state !== before.state) {
      const how = dispositionOf(parsed.data.state);
      const left = readRecordDisposition(beforeMeta);
      if (how && !before.archived_at) {
        const on = await platform().accounts.dayFor(sessionUser(req).id);
        await db.updateTable("assets_assets").set({ archived_at: new Date() } as never).where("id", "=", id).execute();
        await mergeRowMetadata(db, "assets_assets", id, { [DISPOSITION_KEY]: { ...(left ?? {}), how, on: left?.on ?? on } });
        (updated as { archived_at?: unknown }).archived_at = new Date();
      } else if (!how && left && before.archived_at) {
        await db.updateTable("assets_assets").set({ archived_at: null } as never).where("id", "=", id).execute();
        await mergeRowMetadata(db, "assets_assets", id, { [DISPOSITION_KEY]: null });
        (updated as { archived_at?: unknown }).archived_at = null;
      }
    }
    if (patchLocationId !== undefined) {
      try {
        if (patchLocationId) {
          await platform().placement.place({
            orgId: ctx.org.id,
            containee: { kind: "assets:asset", id },
            container: { kind: "core-locations:location", id: patchLocationId },
          });
        } else {
          await platform().placement.remove({
            orgId: ctx.org.id,
            containee: { kind: "assets:asset", id },
          });
        }
      } catch {
        await db.updateTable("assets_assets").set({ location_id: patchLocationId ?? null }).where("id", "=", id).execute();
      }
      (updated as { location_id?: string | null }).location_id = patchLocationId ?? null;
    }
    await platform().activity.log({
      orgId: ctx.org.id,
      userId: sessionUser(req).id,
      action: "asset_updated",
      ref: { module: "assets", entityType: "asset", entityId: id },
      diff: parsed.data,
      before,
    });
    // Flat before/after bags (native columns + flattened metadata) so a
    // transition wire can compare {{event.before.x}} vs {{event.after.x}}.
    // AWAITED: a reactor (e.g. core-mobility) writes back to this asset and
    // the client re-reads right after — the wire must finish first.
    const nativeChanges: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(parsed.data)) {
      if (v !== undefined && k !== "metadata") nativeChanges[k] = v;
    }
    const afterMeta = coerceMetadata((updated as { metadata?: unknown }).metadata);
    await platform().events.emit("assets.asset.updated", {
      orgId: ctx.org.id,
      assetId: id,
      before: { ...before, ...beforeMeta },
      after: { ...before, ...nativeChanges, ...afterMeta },
    });
    res.json(updated);
  }),
);

assetsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const deleted = await db
      .deleteFrom("assets_assets")
      .where("id", "=", id)
      .where("instance", "=", instanceOf(req))
      .returning(["id", "name"])
      .executeTakeFirst();
    if (!deleted) {
      res.status(404).json({ error: { code: "not_found", message: "asset not found" } });
      return;
    }
    await platform().activity.log({
      orgId: ctx.org.id,
      userId: sessionUser(req).id,
      action: "asset_deleted",
      ref: { module: "assets", entityType: "asset", entityId: id },
    });
    await platform().events.emit("assets.asset.deleted", { orgId: ctx.org.id, assetId: id, name: deleted.name });
    res.status(204).end();
  }),
);

void sql;
