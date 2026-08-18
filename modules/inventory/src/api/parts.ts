// /parts — full CRUD plus the stock-adjust endpoint.
//
// Computed reads (assigned_qty, available_qty, low_stock) come from
// joining inventory_allocations + inventory_parts.min_qty at SELECT
// time. We do not denormalise stock totals; one source of truth is
// the row, and aggregations live in the read query.

import { Router, type Request } from "express";
import { z } from "zod";
import { sql, type RawBuilder } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { suggestKindsFromPhoto } from "./suggest-kinds.js";
import { instanceOf, instanceQtyUnit, sessionUser, tenantContext, tenantDb } from "../db.js";
import { asyncHandler, badBody, requireCapability, requireRole } from "./util.js";
import { routeUnknownToMetadata, preserveServerManaged, coerceMetadata } from "./route-helpers.js";
import { disclosureHandler, fieldsShowStockSignal, latchInstanceStock } from "./disclosure.js";
import { computeReconcile } from "../reconcile.js";
import { recordConsumption } from "./stock-ledger.js";

export const partsRouter = Router({ mergeParams: true });

/** The pairing relationship that makes a record a UNIT of a model: the unit row
 *  is the source, the model is the target, both in the same instance. Distinct
 *  from "instance-of" (the CROSS-instance types→items link ParentConfig drives)
 *  on purpose — "how many spools of this filament type" and "how many serials of
 *  this laptop" are different questions and must not share a link.
 *  See docs/design-decisions/serialized-rollup-and-stock-adjust.md. */
const UNIT_OF = "unit-of";

/** The entity kind a part is addressed as, which is what its pairings target:
 *  `<instance>:item` for a named instance, `inventory:part` for the default.
 *  Get this wrong and units_count is silently 0, so both routes derive it here
 *  rather than each spelling it out. Mirrors the UI's rule (ui/context.tsx). */
function partKindOf(req: Request): string {
  const instance = instanceOf(req);
  return instance === "inventory" ? "inventory:part" : `${instance}:item`;
}

/** How many units each of these models has on file, and when the newest was
 *  paired. ONE query for the whole page (countByTargets aggregates), so this is
 *  safe to call from the list. A model with no units is absent from the map and
 *  reads as zero. */
async function unitCountsFor(
  req: Request,
  orgId: string,
  partIds: string[],
): Promise<Map<string, { count: number; latestCreatedAt: string }>> {
  if (partIds.length === 0) return new Map();
  try {
    const rows = await platform().pairings.countByTargets({
      orgId,
      targetKind: partKindOf(req),
      targetIds: partIds,
      relationshipKind: UNIT_OF,
    });
    return new Map(rows.map((r) => [r.targetId, { count: r.count, latestCreatedAt: r.latestCreatedAt }]));
  } catch (err) {
    // Advisory data. A model's units failing to count must never take the list
    // or the detail down with it — the page renders as it did before this
    // existed.
    console.error("[inventory] unit count failed:", (err as Error).message);
    return new Map();
  }
}

/** Sticky-stock latch guard, shared by every qty-bearing write path (create,
 *  PATCH, stock-adjust): the first time a NAMED instance takes a stock-shaped
 *  write, latch it to stock meta-side — so combine/scan see the fungible traits
 *  and the list shows the stock face even before anyone opens it. Skipped when
 *  the user has pinned the instance either way (override present) or it is
 *  already latched — both read for free off req.instanceConfig, so the happy
 *  path is one comparison and no write. The default "inventory" instance is
 *  always stock, never a latch target. */
async function maybeLatchStock(
  req: Request,
  orgId: string,
  fields: Parameters<typeof fieldsShowStockSignal>[0],
): Promise<void> {
  const instance = instanceOf(req);
  if (instance === "inventory") return;
  const cfg = (req as unknown as { instanceConfig?: Record<string, unknown> }).instanceConfig;
  if (typeof cfg?.stock === "boolean" || cfg?.stock_latched === true) return;
  if (fieldsShowStockSignal(fields)) await latchInstanceStock(orgId, instance);
}

// Stock-vs-catalog disclosure for this instance. Registered BEFORE the "/:id"
// routes so it isn't swallowed as a part id. Instance-scoped, so req.instance +
// req.instanceConfig (which carries the sticky override) are populated. See
// disclosure.ts + docs/design-decisions/one-record-substrate.md.
partsRouter.get("/disclosure", disclosureHandler);

const PartCreate = z.object({
  name: z.string().min(1).max(160),
  description: z.string().max(8_000).nullable().optional(),
  category_id: z.string().uuid().nullable().optional(),
  location_id: z.string().uuid().nullable().optional(),
  qty: z.number().nonnegative().optional(),
  unit: z.string().max(40).optional(),
  // Nullable: clearing a cost / reorder point is a legitimate edit (the columns
  // are nullable and the write path handles null); without it an inline cell
  // blanking Min gets a 400 and the value can never be unset from a list.
  cost: z.number().nonnegative().nullable().optional(),
  min_qty: z.number().nonnegative().nullable().optional(),
  manufacturer: z.string().max(120).nullable().optional(),
  supplier_url: z.string().url().max(500).nullable().optional(),
  image_path: z.string().max(500).nullable().optional(),
  notes: z.string().max(8_000).nullable().optional(),
  state: z.enum(["active", "draft", "needs_review"]).optional(),
  metadata: z.record(z.unknown()).optional(),
  // An ESTIMATE, not a count. Setting it is what turns a record into an
  // assortment ("roughly 50 adapters"); clearing it turns the estimate off.
  // Kept apart from `qty` on purpose: a thing is counted or it is guessed at,
  // and letting them share a column would make the guess look like arithmetic.
  approximate_qty: z.number().nonnegative().nullable().optional(),
  // HomeBox parity fields.
  serial_number: z.string().max(160).nullable().optional(),
  model_number: z.string().max(160).nullable().optional(),
  assigned_to: z.string().max(160).nullable().optional(),
  warranty_expires: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  lifetime_warranty: z.boolean().optional(),
  warranty_details: z.string().max(2_000).nullable().optional(),
  insured: z.boolean().optional(),
  archived: z.boolean().optional(),
});

const PartUpdate = PartCreate.partial();

/** The body of PATCH /:id/metadata — a partial custom-field bag to MERGE.
 *  Every key is a field name (same convention as the top-level hoisting on
 *  PATCH /:id), so there are no reserved words to collide with. */
const MetadataMerge = z.record(z.unknown());

/** DB-side merge of a partial custom-field bag: set the non-null keys, REMOVE
 *  the null'd ones. The removal matters — jsonb `||` keeps an explicit null
 *  under the key forever (a tombstone the whole-bag path would never produce,
 *  and one that shadows same-named computed-field provider namespaces via `in`
 *  checks); `- key` actually deletes. */
function metadataMergeExpr(fields: Record<string, unknown>): RawBuilder<Record<string, unknown>> {
  const sets: Record<string, unknown> = {};
  const dels: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined) dels.push(k);
    else sets[k] = v;
  }
  let expr = sql<Record<string, unknown>>`coalesce(metadata, '{}'::jsonb)`;
  if (Object.keys(sets).length > 0) {
    expr = sql<Record<string, unknown>>`${expr} || ${JSON.stringify(sets)}::jsonb`;
  }
  for (const k of dels) {
    expr = sql<Record<string, unknown>>`${expr} - ${k}::text`;
  }
  return expr;
}

/** The same merge applied in memory — for the event's after-image (the DB write
 *  is a SQL expression, not a value we hold). */
function applyMetadataMerge(
  before: Record<string, unknown>,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...before };
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined) delete next[k];
    else next[k] = v;
  }
  return next;
}

const StockAdjust = z.object({
  delta: z.number(),
  reason: z.string().max(500).optional(),
  // Optional provenance for the consumption ledger — e.g. the per-unit panel
  // attributing a bound skein's withdrawal to a project ("allocation" + the
  // allocation id). Omitted for a plain +/- stepper tap.
  source_kind: z.string().max(80).optional(),
  source_id: z.string().max(120).optional(),
});

const Truthy = z.union([z.literal("1"), z.literal("true"), z.literal("0"), z.literal("false")]);
const isTruthy = (v: string | undefined): boolean => v === "1" || v === "true";

const ListQuery = z.object({
  search: z.string().optional(),
  category_id: z.string().uuid().optional(),
  location_id: z.string().uuid().optional(),
  state: z.enum(["active", "draft", "needs_review"]).optional(),
  low_stock: Truthy.optional(),
  /** Show archived rows. Default false — archived parts are hidden
   *  from the list. */
  show_archived: Truthy.optional(),
  /** Only archived rows. Overrides show_archived. */
  archived_only: Truthy.optional(),
  insured_only: Truthy.optional(),
  /** Warranty expires within N days. */
  warranty_expires_within_days: z.coerce.number().int().positive().max(3650).optional(),
  /** Lego-style lifecycle filter (backed by metadata.state).
   *  - "bulk"        → loose individual parts (no kit relationship)
   *  - "kit"         → kits still sealed / built (not parted out)
   *  - "parted-out"  → kits that have been disassembled
   *  See the Lego bundle's `state` field for the full vocabulary.
   *  Workspaces that don't use the Lego bundle just don't pass this. */
  lifecycle: z.enum(["bulk", "kit", "parted-out"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  // Opaque cursor — base64 of {name,id} of the last row on the
  // previous page. Absent = first page.
  cursor: z.string().optional(),
});

function encodeCursor(name: string, id: string): string {
  return Buffer.from(JSON.stringify({ name, id })).toString("base64url");
}
function decodeCursor(c: string): { name: string; id: string } | null {
  try {
    const o = JSON.parse(Buffer.from(c, "base64url").toString("utf8"));
    if (typeof o?.name === "string" && typeof o?.id === "string") return o;
  } catch {
    /* malformed cursor — treat as no cursor */
  }
  return null;
}

partsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const q = ListQuery.safeParse(req.query);
    if (!q.success) return badBody(res, q.error);
    const filter = q.data;
    const db = tenantDb(req);

    let query = db
      .selectFrom("inventory_parts as p")
      .leftJoin("inventory_categories as c", "c.id", "p.category_id")
      .select((eb) => [
        "p.id",
        "p.name",
        "p.description",
        "p.qty",
        "p.unit",
        "p.cost",
        "p.min_qty",
        "p.manufacturer",
        "p.supplier_url",
        "p.image_path",
        "p.notes",
        "p.state",
        "p.metadata",
        // The assortment signal. A list is where "a full bin looks empty" does
        // the most damage, so the row needs to know the 0 in `qty` is not the
        // whole story. See docs/design-decisions/assorted-contents.md.
        "p.approximate_qty",
        "p.estimated_at",
        "p.created_at",
        "p.updated_at",
        "p.category_id",
        "c.name as category_name",
        "p.location_id",
        "p.asset_id",
        "p.serial_number",
        "p.model_number",
        "p.warranty_expires",
        "p.lifetime_warranty",
        "p.warranty_details",
        "p.insured",
        "p.archived",
        // Aggregated reserved quantity from active allocations.
        eb
          .selectFrom("inventory_allocations as a")
          .select(sql<string>`coalesce(sum(a.qty), 0)`.as("v"))
          .whereRef("a.part_id", "=", "p.id")
          .where("a.status", "=", "reserved")
          .as("assigned_qty"),
      ])
      // Stable order: name, then id as tiebreaker (names aren't
      // unique) — required for correct cursor pagination.
      .orderBy("p.name")
      .orderBy("p.id");
    // Scope to the request's instance (default "inventory" on legacy
    // /modules/inventory/parts; the instance slug on /instances/:n/items).
    // ?all_instances=1 reads the WHOLE stash across instances — the
    // cross-module consumers (a design's Materials picker, pattern→stash
    // matching) need yarn that lives in a "yarn" instance, hooks in
    // "hooks", etc. Read-only widening; writes stay instance-scoped.
    if (req.query.all_instances !== "1") {
      query = query.where("p.instance", "=", instanceOf(req));
    }

    if (filter.search) {
      const raw = filter.search.trim();
      // HomeBox-style `#NNN` syntax: search by asset_id (zero-padded
      // or not, parse the integer suffix).
      const assetMatch = raw.match(/^#?\s*0*(\d+)\s*$/);
      if (assetMatch) {
        query = query.where("p.asset_id", "=", Number(assetMatch[1]));
      } else {
        // H8: one trigram-GIN-indexed column (search_blob) instead of a
        // 5-column OR of LIKE '%…%' (which can't use indexes and
        // seq-scans at scale). search_blob is already lower()'d and
        // concatenates name + notes + serial + model + manufacturer, so
        // this matches the old behaviour but is an index scan at 40k+.
        const like = `%${raw.toLowerCase()}%`;
        query = query.where(sql<boolean>`p.search_blob like ${like}`);
      }
    }
    if (filter.category_id) query = query.where("p.category_id", "=", filter.category_id);
    if (filter.location_id) query = query.where("p.location_id", "=", filter.location_id);
    if (filter.state) query = query.where("p.state", "=", filter.state);
    if (filter.lifecycle === "bulk") {
      // Match either the new `lifecycle` field (Lego bundle v0.3+) or
      // a missing field (default = loose). The legacy `state` key is
      // accepted for backwards compat on workspaces that haven't
      // re-installed the bundle.
      query = query.where(
        sql<boolean>`coalesce(p.metadata->>'lifecycle', p.metadata->>'state', 'loose') in ('loose', 'bulk', 'spare')`,
      );
    } else if (filter.lifecycle === "kit") {
      query = query.where(
        sql<boolean>`coalesce(p.metadata->>'lifecycle', p.metadata->>'state') in ('sealed', 'built')`,
      );
    } else if (filter.lifecycle === "parted-out") {
      query = query.where(
        sql<boolean>`coalesce(p.metadata->>'lifecycle', p.metadata->>'state') = 'parted-out'`,
      );
    }

    // Archived defaults to hidden. archived_only takes precedence;
    // otherwise show_archived widens the result set.
    if (isTruthy(filter.archived_only)) {
      query = query.where("p.archived", "=", true);
    } else if (!isTruthy(filter.show_archived)) {
      query = query.where("p.archived", "=", false);
    }
    if (isTruthy(filter.insured_only)) {
      query = query.where("p.insured", "=", true);
    }
    if (filter.warranty_expires_within_days) {
      const days = filter.warranty_expires_within_days;
      query = query.where(
        sql<boolean>`p.warranty_expires is not null and p.warranty_expires <= (current_date + ${days} * interval '1 day')`,
      );
    }

    // Cursor: keyset pagination on the (name, id) ordering.
    if (filter.cursor) {
      const c = decodeCursor(filter.cursor);
      if (c) {
        query = query.where(
          sql<boolean>`(p.name, p.id) > (${c.name}, ${c.id})`,
        );
      }
    }

    const lowStockOnly =
      filter.low_stock === "1" || filter.low_stock === "true";

    // low_stock is a post-filter (it depends on the computed
    // available qty). Mixing it with keyset pagination would make
    // next_cursor unreliable, so when it's on we fetch a generous
    // single page — the low-stock subset is inherently small.
    const fetchLimit = lowStockOnly ? 200 : filter.limit + 1;
    const rows = await query.limit(fetchLimit).execute();

    let hasMore = false;
    let pageRows = rows;
    if (!lowStockOnly && rows.length > filter.limit) {
      hasMore = true;
      pageRows = rows.slice(0, filter.limit);
    }

    const items = pageRows.map((r) => {
      const qty = Number(r.qty);
      const assigned = Number(r.assigned_qty ?? 0);
      const minQty = r.min_qty != null ? Number(r.min_qty) : null;
      const available = qty - assigned;
      // Days until warranty expires — null when no warranty date.
      let warranty_days_until: number | null = null;
      if (r.warranty_expires) {
        const ms = new Date(r.warranty_expires).getTime() - Date.now();
        warranty_days_until = Math.ceil(ms / 86_400_000);
      }
      const approximate = r.approximate_qty == null ? null : Number(r.approximate_qty);
      return {
        ...r,
        qty,
        cost: r.cost == null ? null : Number(r.cost),
        min_qty: minQty,
        approximate_qty: approximate,
        assigned_qty: assigned,
        available_qty: available,
        // An estimate is never low stock: its `qty` is 0 because nobody counted,
        // not because the bin is empty, so comparing it to a minimum would put a
        // reorder warning on a bin holding fifty of the thing.
        low_stock: minQty != null && approximate == null && available <= minQty,
        warranty_days_until,
        location_name: null as string | null,
      };
    });
    const filtered = lowStockOnly
      ? items.filter((p) => p.low_stock)
      : items;

    // Cross-module read for the location name: go through the
    // resolver (no direct table read) per module-layers.md.
    const ctx = tenantContext(req);
    const locationIds = Array.from(
      new Set(
        filtered
          .map((p) => p.location_id)
          .filter((id): id is string => !!id),
      ),
    );
    if (locationIds.length > 0) {
      const resolved = await platform().entities.lookupMany(
        ctx.org.id,
        locationIds.map((id) => ({ kind: "core-locations:location", id })),
      );
      const byId = new Map(resolved.map((r) => [r.id, r.title]));
      for (const p of filtered) {
        if (p.location_id) p.location_name = byId.get(p.location_id) ?? null;
      }
    }

    // Catalog-image fallback: for parts that don't carry their own
    // image_path, walk the `matches → core-catalogs:entry` pairing
    // and use the matched entry's image_path. One batched pairings
    // lookup + one batched lookupMany — no N+1.
    // Skip parts whose identity is a colour SWATCH (a valid colour hex, e.g. a
    // yarn's colourway): a generic catalog photo would suppress the swatch the
    // user wants (the thumbnail prefers a photo over a colour).
    const hasColorSwatch = (p: { metadata?: unknown }) =>
      /^#[0-9a-fA-F]{3,8}$/.test(String((p.metadata as Record<string, unknown> | null | undefined)?.color ?? "").trim());
    const partsNeedingImage = filtered
      .filter((p) => !p.image_path && !hasColorSwatch(p))
      .map((p) => p.id);
    if (partsNeedingImage.length > 0) {
      const pairs = await platform().pairings.findBySources({
        orgId: ctx.org.id,
        sourceKind: "inventory:part",
        sourceIds: partsNeedingImage,
        targetKind: "core-catalogs:entry",
        relationshipKind: "matches",
      });
      if (pairs.length > 0) {
        // Some parts may have multiple matches (e.g. matched in two
        // different catalogs). Keep the first one — order is undefined
        // but stable per call.
        const targetByPart = new Map<string, string>();
        for (const p of pairs) {
          if (!targetByPart.has(p.sourceId)) {
            targetByPart.set(p.sourceId, p.targetId);
          }
        }
        const entries = await platform().entities.lookupMany(
          ctx.org.id,
          Array.from(new Set(targetByPart.values())).map((id) => ({
            kind: "core-catalogs:entry",
            id,
          })),
        );
        const imageByEntryId = new Map<string, string>();
        for (const e of entries) {
          if (e.image_path) imageByEntryId.set(e.id, e.image_path);
        }
        for (const p of filtered) {
          if (p.image_path) continue;
          const targetId = targetByPart.get(p.id);
          if (!targetId) continue;
          const img = imageByEntryId.get(targetId);
          if (img) p.image_path = img;
        }
      }
    }

    // Units on file, for the whole page in ONE query — bolted onto the batched
    // enrichment above (location names, catalog images) rather than resolved per
    // row. `items` here is what the parts list renders, so a per-row count would
    // be an N+1 on the hottest read in the module.
    const unitCounts = await unitCountsFor(req, ctx.org.id, filtered.map((p) => p.id));
    const withUnits = filtered.map((p) => ({ ...p, units_count: unitCounts.get(p.id)?.count ?? 0 }));

    const last = filtered[filtered.length - 1];
    const next_cursor =
      hasMore && last ? encodeCursor(last.name, last.id) : null;

    // This route is a SECOND read path over the same rows the generic entity
    // resolver serves, and only that one post-processed. So a relation or
    // member field printed its raw uuid here while reading correctly through
    // /entities/:kind. One helper, applied at both, until the two queries are
    // collapsed into one.
    const labelled = await platform().entities.withFieldLabels(
      ctx.org.id,
      // Field defs are keyed by the kind the caller asked for: a non-default
      // instance carries its own defs under `<instance>:item`.
      instanceOf(req) === "inventory" ? "inventory:part" : `${instanceOf(req)}:item`,
      withUnits,
    );

    res.json({ items: labelled, next_cursor });
  }),
);

// CSV export — same shape as the list query (search + filters), but
// returns every matching row (no pagination) as text/csv. Headers
// match the importer's synonyms so the export round-trips.
partsRouter.get(
  "/export.csv",
  asyncHandler(async (req, res) => {
    const q = ListQuery.safeParse(req.query);
    if (!q.success) return badBody(res, q.error);
    const filter = q.data;
    const db = tenantDb(req);

    let query = db
      .selectFrom("inventory_parts as p")
      .leftJoin("inventory_categories as c", "c.id", "p.category_id")
      .select([
        "p.id",
        "p.asset_id",
        "p.name",
        "p.description",
        "p.qty",
        "p.approximate_qty",
        "p.unit",
        "p.cost",
        "p.min_qty",
        "p.manufacturer",
        "p.serial_number",
        "p.model_number",
        "p.supplier_url",
        "p.notes",
        "p.warranty_expires",
        "p.lifetime_warranty",
        "p.warranty_details",
        "p.insured",
        "p.archived",
        "p.state",
        "c.name as category_name",
        "p.location_id",
        "p.created_at",
      ])
      .orderBy("p.asset_id", "asc")
      .where("p.instance", "=", instanceOf(req));

    if (filter.search) {
      const raw = filter.search.trim();
      const assetMatch = raw.match(/^#?\s*0*(\d+)\s*$/);
      if (assetMatch) {
        query = query.where("p.asset_id", "=", Number(assetMatch[1]));
      } else {
        const like = `%${raw.toLowerCase()}%`;
        query = query.where((eb) =>
          eb.or([
            eb(sql<string>`lower(p.name)`, "like", like),
            eb(sql<string>`lower(coalesce(p.serial_number,''))`, "like", like),
            eb(sql<string>`lower(coalesce(p.model_number,''))`, "like", like),
            eb(sql<string>`lower(coalesce(p.manufacturer,''))`, "like", like),
          ]),
        );
      }
    }
    if (filter.category_id) query = query.where("p.category_id", "=", filter.category_id);
    if (filter.location_id) query = query.where("p.location_id", "=", filter.location_id);
    if (filter.state) query = query.where("p.state", "=", filter.state);
    if (isTruthy(filter.archived_only)) {
      query = query.where("p.archived", "=", true);
    } else if (!isTruthy(filter.show_archived)) {
      query = query.where("p.archived", "=", false);
    }
    if (isTruthy(filter.insured_only)) query = query.where("p.insured", "=", true);

    const rows = await query.execute();

    // Resolve location names through the platform resolver (one
    // batch).
    const locationIds = Array.from(
      new Set(rows.map((r) => r.location_id).filter((id): id is string => !!id)),
    );
    const locationNames = new Map<string, string>();
    if (locationIds.length > 0) {
      const ctx = tenantContext(req);
      const resolved = await platform().entities.lookupMany(
        ctx.org.id,
        locationIds.map((id) => ({ kind: "core-locations:location", id })),
      );
      for (const r of resolved) locationNames.set(r.id, r.title);
    }

    const headers = [
      "asset_id",
      "name",
      "description",
      "qty",
      "approximate_qty",
      "unit",
      "cost",
      "min_qty",
      "manufacturer",
      "serial_number",
      "model_number",
      "supplier_url",
      "warranty_expires",
      "lifetime_warranty",
      "warranty_details",
      "insured",
      "archived",
      "state",
      "category",
      "location",
      "notes",
      "created_at",
    ];

    const lines: string[] = [headers.join(",")];
    for (const r of rows) {
      const cells = [
        r.asset_id != null ? String(r.asset_id) : "",
        r.name,
        r.description ?? "",
        r.qty,
        r.approximate_qty ?? "",
        r.unit,
        r.cost ?? "",
        r.min_qty ?? "",
        r.manufacturer ?? "",
        r.serial_number ?? "",
        r.model_number ?? "",
        r.supplier_url ?? "",
        r.warranty_expires
          ? new Date(r.warranty_expires).toISOString().slice(0, 10)
          : "",
        r.lifetime_warranty ? "true" : "false",
        r.warranty_details ?? "",
        r.insured ? "true" : "false",
        r.archived ? "true" : "false",
        r.state,
        r.category_name ?? "",
        r.location_id ? (locationNames.get(r.location_id) ?? "") : "",
        r.notes ?? "",
        new Date(r.created_at).toISOString(),
      ];
      lines.push(cells.map(csvCell).join(","));
    }
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="inventory-${date}.csv"`,
    );
    res.send(lines.join("\n") + "\n");
  }),
);

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  // Quote if contains comma / quote / newline. Double internal quotes.
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

partsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const row = await db
      .selectFrom("inventory_parts")
      .selectAll()
      .where("id", "=", id)
      .where("instance", "=", instanceOf(req))
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "part not found" } });
      return;
    }
    // The individual face's number. `units_count` is DERIVED (count of unit-of
    // pairings), never stored — the model's own qty stays the count face's
    // number, and the two disagreeing is information the client surfaces rather
    // than a drift to reconcile silently. See one-record-substrate.md.
    const units = await unitCountsFor(req, tenantContext(req).org.id, [row.id]);
    const u = units.get(row.id);
    const unitsCount = u?.count ?? 0;
    const unitsLatestAt = u?.latestCreatedAt ?? null;
    // Derived from the SAME numbers the response carries — never re-queried, or
    // the card could disagree with the figures printed beside it. Null for the
    // common cases (no units, or the numbers agree), so a plain part pays one
    // comparison. Detail only: the list shows the passive chip, which it can
    // compute from qty + units_count itself, and a question belongs where you
    // can answer it.
    const meta = coerceMetadata((row as { metadata?: unknown }).metadata);
    const reconcile = computeReconcile({
      qty: Number(row.qty),
      unitsCount,
      unitsLatestAt,
      dismissedRaw: meta.reconcile_dismissed,
    });
    res.json({
      ...row,
      units_count: unitsCount,
      units_latest_at: unitsLatestAt,
      reconcile,
    });
  }),
);

// The UNITS of a model — the individual records paired to it via unit-of. A unit
// IS a part (same instance), so each is returned with the fields the units panel
// shows and links to its own detail. Newest first, so a just-added serial is at
// the top. See docs/design-decisions/within-instance-units.md.
partsRouter.get(
  "/:id/units",
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const kind = partKindOf(req);
    const pairs = await platform().pairings.findByTargets({
      orgId: tenantContext(req).org.id,
      sourceKind: kind,
      targetKind: kind,
      targetIds: [id],
      relationshipKind: UNIT_OF,
    });
    const unitIds = pairs.map((p) => p.sourceId);
    if (unitIds.length === 0) {
      res.json({ items: [] });
      return;
    }
    const rows = await tenantDb(req)
      .selectFrom("inventory_parts")
      .select(["id", "name", "qty", "serial_number", "assigned_to", "location_id", "image_path", "created_at"])
      .where("id", "in", unitIds)
      .where("instance", "=", instanceOf(req))
      .orderBy("created_at", "desc")
      .execute();
    res.json({ items: rows });
  }),
);

const MintUnit = z.object({
  serial_number: z.string().max(160).optional(),
  name: z.string().min(1).max(160).optional(),
});

// Mint a UNIT of this model: a child part in the SAME instance, paired unit-of.
// It does NOT touch the model's qty — qty is what you counted, units_count is
// what's on file, and them disagreeing is the reconciliation prompt's whole job
// (one-record-substrate.md / within-instance-units.md). A unit is one physical
// thing → qty 1, and a leaf.
// AI-REACH: mints serialised units of a part; a labelling step done with the items in hand
partsRouter.post(
  "/:id/units",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "inventory:create-part"))) return;
    const modelId = req.params.id;
    if (!modelId) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const parsed = MintUnit.safeParse(req.body ?? {});
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const session = sessionUser(req);
    const inst = instanceOf(req);

    const model = await db
      .selectFrom("inventory_parts")
      .select(["id", "name"])
      .where("id", "=", modelId)
      .where("instance", "=", inst)
      .executeTakeFirst();
    if (!model) {
      res.status(404).json({ error: { code: "not_found", message: "model not found" } });
      return;
    }

    const serial = parsed.data.serial_number?.trim() || null;
    // Default a unit's name from its model + serial, so a bare "add a serial"
    // yields "ThinkPad X1 · SN-014" rather than an untitled row.
    const name = parsed.data.name?.trim() || (serial ? `${model.name} · ${serial}` : model.name);

    const unit = await db
      .insertInto("inventory_parts")
      .values({
        instance: inst,
        name,
        qty: "1",
        unit: instanceQtyUnit(req) ?? "each",
        serial_number: serial,
        metadata: {},
      })
      .returning(["id", "name", "qty", "serial_number", "created_at"])
      .executeTakeFirstOrThrow();

    await platform().pairings.create({
      orgId: ctx.org.id,
      sourceKind: partKindOf(req),
      sourceId: unit.id,
      targetKind: partKindOf(req),
      targetId: modelId,
      relationshipKind: UNIT_OF,
      createdBy: session.id,
    });
    await platform().activity.log({
      orgId: ctx.org.id,
      userId: session.id,
      action: "unit_added",
      ref: { module: "inventory", entityType: "part", entityId: modelId },
      diff: { unit_id: unit.id, serial },
    });
    platform().events.emit("inventory.part.created", { orgId: ctx.org.id, partId: unit.id });

    res.status(201).json(unit);
  }),
);

// The consumption ledger for a part — what drew it down and how much, newest
// first. For a consumable (a spool) this is its print/usage history; with
// metadata.capacity + qty (remaining) it tells the whole "1kg → these prints →
// this much left" story.
partsRouter.get(
  "/:id/consumption",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const items = await db
      .selectFrom("inventory_consumption")
      .select(["id", "delta", "reason", "source_kind", "source_id", "at"])
      .where("part_id", "=", id)
      .orderBy("at", "desc")
      .limit(200)
      .execute();
    res.json({ items });
  }),
);

// D6: top-level keys the PartCreate / PartUpdate schemas know about.
// Derived from the zod schema's shape so they stay in sync. Anything
// not in here that the caller sends gets hoisted into metadata by
// routeUnknownToMetadata().
const NATIVE_PART_KEYS = new Set(Object.keys(PartCreate.shape));

// POST /:id/suggest-kinds — one vision read over this record's photo, returning
// proposed kinds for the user to accept or drop. Suggestion only: nothing is
// written here, because a model's guess about somebody's bin is a starting
// point and not a fact.
//
// AI-REACH: exempt — reads a photo and returns suggestions; writes nothing, so
// there is no state for an agent to reach. An agent that wants to break a bin
// into kinds creates the parts directly (that path IS reachable) rather than
// asking this endpoint to think for it. Mutating only in the POST sense.
partsRouter.post(
  "/:id/suggest-kinds",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "inventory:create-part"))) return;
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const row = await db
      .selectFrom("inventory_parts")
      .select(["image_path"])
      .where("id", "=", req.params.id as string)
      .where("instance", "=", instanceOf(req))
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "part not found" } });
      return;
    }
    if (!row.image_path) {
      res.status(400).json({
        error: { code: "no_photo", message: "Photograph the bin first, then ask." },
      });
      return;
    }
    const kinds = await suggestKindsFromPhoto(ctx.org.id, row.image_path, sessionUser(req).id);
    res.json({ kinds });
  }),
);

partsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "inventory:create-part"))) return;
    const routed = routeUnknownToMetadata(req.body, NATIVE_PART_KEYS);
    const parsed = PartCreate.safeParse(routed);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const session = sessionUser(req);

    const inserted = await db
      .insertInto("inventory_parts")
      .values({
        instance: instanceOf(req),
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        category_id: parsed.data.category_id ?? null,
        qty: String(parsed.data.qty ?? 0),
        // Creating something already described as "roughly 50" is the common
        // path (a photo of a bin becomes an assortment), so the stamp is set
        // here too rather than only on a later edit.
        approximate_qty:
          parsed.data.approximate_qty == null ? null : String(parsed.data.approximate_qty),
        estimated_at: parsed.data.approximate_qty == null ? null : new Date(),
        // The instance's qty_unit (a yarn instance tracks skeins) beats the
        // generic "each" when the caller doesn't say — so API creates (scan
        // confirm, CSV import) match what the New-<noun> modal would do.
        unit: parsed.data.unit ?? instanceQtyUnit(req) ?? "each",
        cost: parsed.data.cost != null ? String(parsed.data.cost) : null,
        min_qty: parsed.data.min_qty != null ? String(parsed.data.min_qty) : null,
        manufacturer: parsed.data.manufacturer ?? null,
        supplier_url: parsed.data.supplier_url ?? null,
        image_path: parsed.data.image_path ?? null,
        notes: parsed.data.notes ?? null,
        state: parsed.data.state ?? "active",
        metadata: parsed.data.metadata ?? {},
        serial_number: parsed.data.serial_number ?? null,
        model_number: parsed.data.model_number ?? null,
        assigned_to: parsed.data.assigned_to ?? null,
        warranty_expires: parsed.data.warranty_expires
          ? new Date(parsed.data.warranty_expires)
          : null,
        lifetime_warranty: parsed.data.lifetime_warranty ?? false,
        warranty_details: parsed.data.warranty_details ?? null,
        insured: parsed.data.insured ?? false,
        archived: parsed.data.archived ?? false,
      })
      .returning(["id", "name", "qty", "state", "metadata", "asset_id", "created_at"])
      .executeTakeFirstOrThrow();

    // Create-then-place: the location rides the placement seam
    // (placement-cutover-plan step 1); place() keeps the legacy column
    // mirrored. Fall back to the direct column write if placement refuses.
    if (parsed.data.location_id) {
      try {
        await platform().placement.place({
          orgId: ctx.org.id,
          containee: { kind: "inventory:part", id: inserted.id },
          container: { kind: "core-locations:location", id: parsed.data.location_id },
        });
      } catch {
        await db
          .updateTable("inventory_parts")
          .set({ location_id: parsed.data.location_id })
          .where("id", "=", inserted.id)
          .execute();
      }
    }

    await platform().activity.log({
      orgId: ctx.org.id,
      userId: session.id,
      action: "part_created",
      ref: { module: "inventory", entityType: "part", entityId: inserted.id },
      diff: { name: inserted.name, qty: inserted.qty },
    });
    platform().events.emit("inventory.part.created", {
      orgId: ctx.org.id,
      partId: inserted.id,
    });

    await maybeLatchStock(req, ctx.org.id, {
      qty: parsed.data.qty,
      min_qty: parsed.data.min_qty,
      unit: parsed.data.unit ?? instanceQtyUnit(req) ?? "each",
    });

    // Auto-lift to a parent type. If this instance's items belong to a parent
    // TYPE derived from the item's OWN fields (the instance's parent config
    // carries `key_fields`) and this create carried those fields — a scan /
    // import that filled e.g. material/colour/diameter, NOT a manual create
    // that picks the parent via the picker (which leaves them empty and links
    // its own parent) — find-or-create the type and link this item, so a
    // scanned spool lands in the type→spool model instead of as a flat row.
    // Best-effort; a failure never blocks the create.
    const parentCfg = (req as unknown as { instanceConfig?: Record<string, unknown> }).instanceConfig
      ?.parent as
      | { instance?: string; relationship_kind?: string; key_fields?: string[]; copy_fields?: string[] }
      | undefined;
    const liftKeys = Array.isArray(parentCfg?.key_fields)
      ? parentCfg!.key_fields.filter((f) => !["name", "manufacturer", "qty", "unit"].includes(f))
      : [];
    if (parentCfg?.instance && liftKeys.length > 0) {
      const md = (parsed.data.metadata ?? {}) as Record<string, unknown>;
      // Only when the (metadata) key fields are actually present — a manual
      // parent-picker create leaves them empty and links its own parent.
      const hasKeys = liftKeys.every((f) => md[f] != null && String(md[f]).trim() !== "");
      if (hasKeys) {
        await platform()
          .actions.invoke("inventory:lift-to-type", {
            orgId: ctx.org.id,
            userId: session.id,
            entity: { kind: "inventory:part", id: inserted.id },
            event: {
              name: "inventory.part.created",
              payload: {},
              actor: { user_id: session.id, display_name: null, auth_method: "session" },
              timestamp: new Date().toISOString(),
              trigger_type: "on-create",
            },
            args: {
              source_instance: instanceOf(req),
              type_instance: parentCfg.instance,
              key_fields: parentCfg.key_fields,
              copy_fields: parentCfg.copy_fields ?? [],
              relationship_kind: parentCfg.relationship_kind ?? "instance-of",
              source_ids: [inserted.id],
            },
            entityKind: "inventory:part",
            entityId: inserted.id,
          })
          .catch((err) => console.error("[inventory] auto-lift to type failed:", (err as Error).message));
      }
    }

    res.status(201).json(inserted);
  }),
);

// Change SOME custom fields, leaving the rest of the bag alone.
//
// An explicit `metadata` on PATCH /:id REPLACES the bag, so a caller changing
// one field that way must read the row, spread it, and write it back — and that
// read-spread-write drops anything another writer committed in between. The bag
// has many writers (wires, the scan pipeline, another tab, another person), and
// a LIST row can be minutes stale. Same class as scripts/lint-jsonb-merge.ts,
// which enforces the merge DB-side; it just can't see a CLIENT-side spread.
// This route is the merge surface: send only the fields to change, null to
// clear one, and the merge happens in Postgres with no snapshot to go stale.
//
// Why a sub-resource and not a `metadata_patch` field on PATCH /:id: unknown
// top-level keys on that route are hoisted into metadata as CUSTOM FIELD NAMES
// (routeUnknownToMetadata), so a new top-level parameter is indistinguishable
// from a user's field of the same name — an API that predates the parameter
// stores it as data instead of honouring it. A separate ROUTE fails safe in
// that deploy skew: an api without it 404s, the client shows "couldn't save",
// and nothing is destroyed.
//
// AI-REACH: crud — a partial update of the inventory:part kind's custom fields
// (a merge variant of the PATCH /:id update); Cobb changes part fields through
// the part kind's update surface, not this transport-level sub-resource.
partsRouter.patch(
  "/:id/metadata",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "inventory:update-part"))) return;
    const parsed = MetadataMerge.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const session = sessionUser(req);

    const before = await db
      .selectFrom("inventory_parts")
      .selectAll()
      .where("id", "=", id)
      .where("instance", "=", instanceOf(req))
      .executeTakeFirst();
    if (!before) {
      res.status(404).json({ error: { code: "not_found", message: "part not found" } });
      return;
    }

    // Server-managed keys are dropped rather than merged: the client never owns
    // those, and merging one would be a write the server has to undo.
    const smNames = await platform().entities.serverManagedFields(ctx.org.id, "inventory:part");
    const own = Object.fromEntries(
      Object.entries(parsed.data).filter(([k]) => !smNames.includes(k)),
    );

    const updated = await db
      .updateTable("inventory_parts")
      .set({
        // Merge in Postgres, so a concurrent writer's key survives. There is no
        // in-memory snapshot here to go stale.
        metadata: metadataMergeExpr(own),
        updated_at: new Date(),
      })
      .where("id", "=", id)
      .where("instance", "=", instanceOf(req))
      .returning(["id", "name", "qty", "state", "updated_at"])
      .executeTakeFirst();
    if (!updated) {
      res.status(404).json({ error: { code: "not_found", message: "part not found" } });
      return;
    }

    await platform().activity.log({
      orgId: ctx.org.id,
      userId: session.id,
      action: "part_updated",
      ref: { module: "inventory", entityType: "part", entityId: updated.id },
      diff: { metadata: own },
    });
    // Same event shape as PATCH /:id — a wire comparing {{event.before.x}} vs
    // {{event.after.x}} must fire for a custom-field edit too. The after-bag is
    // recomputed (the write is a SQL expression, not a value we hold).
    const beforeMeta = coerceMetadata((before as { metadata?: unknown }).metadata);
    await platform().events.emit("inventory.part.updated", {
      orgId: ctx.org.id,
      partId: updated.id,
      before: { ...before, ...beforeMeta },
      after: { ...before, ...applyMetadataMerge(beforeMeta, own) },
    });

    res.json(updated);
  }),
);

partsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "inventory:update-part"))) return;
    const routed = routeUnknownToMetadata(req.body, NATIVE_PART_KEYS);
    const parsed = PartUpdate.safeParse(routed);
    if (!parsed.success) return badBody(res, parsed.error);
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const session = sessionUser(req);

    // Read the current row FIRST — it's the before-image for the change event
    // AND the source of truth for any server-managed field the client tried to
    // overwrite (metadata is written wholesale, so a stale client value would
    // otherwise clobber a server-stamped one).
    const before = await db
      .selectFrom("inventory_parts")
      .selectAll()
      .where("id", "=", id)
      .where("instance", "=", instanceOf(req))
      .executeTakeFirst();
    if (!before) {
      res.status(404).json({ error: { code: "not_found", message: "part not found" } });
      return;
    }

    const smNames = await platform().entities.serverManagedFields(ctx.org.id, "inventory:part");
    // Two metadata intents, split by whether the CALLER sent `metadata`:
    // - explicit `metadata` REPLACES the bag (the documented contract; keys are
    //   removed by omission), with server-managed values preserved from the row.
    // - keys that only arrived via the top-level HOIST are single-field writes
    //   ("set colorway") — those MERGE DB-side, same as PATCH /:id/metadata.
    //   Replacing here would let one bare field name wipe every other custom
    //   field on the part, from any API caller.
    const hadExplicitMetadata =
      !!req.body &&
      typeof req.body === "object" &&
      (req.body as Record<string, unknown>).metadata !== undefined;
    let hoistedMerge: Record<string, unknown> | null = null;
    if (parsed.data.metadata !== undefined) {
      if (hadExplicitMetadata) {
        parsed.data.metadata = preserveServerManaged(
          parsed.data.metadata as Record<string, unknown>,
          coerceMetadata((before as { metadata?: unknown }).metadata),
          smNames,
        );
      } else {
        hoistedMerge = Object.fromEntries(
          Object.entries(parsed.data.metadata as Record<string, unknown>).filter(
            ([k]) => !smNames.includes(k),
          ),
        );
        delete (parsed.data as Record<string, unknown>).metadata;
      }
    }

    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(parsed.data)) {
      if (v === undefined) continue;
      if (k === "qty" || k === "cost" || k === "min_qty" || k === "approximate_qty") {
        patch[k] = v == null ? null : String(v);
      } else if (k === "warranty_expires") {
        patch[k] = v == null ? null : new Date(v as string);
      } else {
        patch[k] = v;
      }
    }
    if (hoistedMerge && Object.keys(hoistedMerge).length > 0) {
      patch.metadata = metadataMergeExpr(hoistedMerge);
    }
    // An estimate dates itself. The caller never sets estimated_at: it is the
    // moment the guess was made, and a client that could backdate it would make
    // "how old is this guess" unanswerable.
    if ("approximate_qty" in patch) {
      patch.estimated_at = patch.approximate_qty == null ? null : new Date();
    }
    patch.updated_at = new Date();

    const updated = await db
      .updateTable("inventory_parts")
      .set(patch)
      .where("id", "=", id)
      .where("instance", "=", instanceOf(req))
      .returning(["id", "name", "qty", "state", "updated_at"])
      .executeTakeFirst();
    if (!updated) {
      res.status(404).json({ error: { code: "not_found", message: "part not found" } });
      return;
    }

    await platform().activity.log({
      orgId: ctx.org.id,
      userId: session.id,
      action: "part_updated",
      ref: { module: "inventory", entityType: "part", entityId: updated.id },
      diff: parsed.data,
    });
    // Flat before/after field bags (native columns + flattened metadata) so a
    // transition-aware wire can compare {{event.before.x}} vs {{event.after.x}}
    // and a server-side reactor (e.g. core-mobility) can recompute from the
    // delta. `metadata` was preserved above, so `after` reflects the write.
    const beforeMeta = coerceMetadata((before as { metadata?: unknown }).metadata);
    const nativeChanges: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
      if (k !== "metadata" && k !== "updated_at") nativeChanges[k] = v;
    }
    const afterMeta =
      parsed.data.metadata !== undefined
        ? ((patch.metadata as Record<string, unknown>) ?? {})
        : hoistedMerge
          ? applyMetadataMerge(beforeMeta, hoistedMerge)
          : beforeMeta;
    // AWAIT: a transition wire (e.g. core-mobility's recompute-away) runs on
    // this event and writes back to the same part; the client re-reads right
    // after, so the wire must finish before we respond or the read races it.
    await platform().events.emit("inventory.part.updated", {
      orgId: ctx.org.id,
      partId: updated.id,
      before: { ...before, ...beforeMeta },
      after: { ...before, ...nativeChanges, ...afterMeta },
    });

    // A stock-shaped EDIT is signal too — a user adding a real qty / reorder
    // point / measured unit to an existing catalog record must latch the
    // instance the same as a create, or traits lag until someone opens the list.
    // Only the fields THIS patch touched count (an untouched qty of 0 isn't a
    // signal, and unrelated edits must not probe).
    await maybeLatchStock(req, ctx.org.id, {
      qty: parsed.data.qty,
      min_qty: parsed.data.min_qty,
      unit: parsed.data.unit,
    });

    res.json(updated);
  }),
);

partsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const session = sessionUser(req);

    const deleted = await db
      .deleteFrom("inventory_parts")
      .where("id", "=", id)
      .where("instance", "=", instanceOf(req))
      .returning(["id", "name"])
      .executeTakeFirst();
    if (!deleted) {
      res.status(404).json({ error: { code: "not_found", message: "part not found" } });
      return;
    }

    await platform().activity.log({
      orgId: ctx.org.id,
      userId: session.id,
      action: "part_deleted",
      ref: { module: "inventory", entityType: "part", entityId: deleted.id },
      diff: { name: deleted.name },
    });
    platform().events.emit("inventory.part.deleted", {
      orgId: ctx.org.id,
      partId: deleted.id,
    });

    res.status(204).end();
  }),
);

// AI-ACTION: inventory:adjust-stock
partsRouter.post(
  "/:id/stock-adjust",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "inventory:adjust-stock"))) return;
    const parsed = StockAdjust.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const session = sessionUser(req);

    const updated = await db
      .updateTable("inventory_parts")
      .set({
        qty: sql<string>`qty + ${String(parsed.data.delta)}::numeric`,
        updated_at: new Date(),
      })
      .where("id", "=", id)
      .where("instance", "=", instanceOf(req))
      .returning(["id", "name", "qty", "min_qty"])
      .executeTakeFirst();
    if (!updated) {
      res.status(404).json({ error: { code: "not_found", message: "part not found" } });
      return;
    }

    // Consumption ledger (append-only): this HTTP path historically skipped it —
    // the documented "ledgered stock-adjust endpoint" was aspirational, so the
    // per-unit panel's own Open/Use taps (which route through here) left no
    // statement line and the running balance had nothing to walk. Fixed via the
    // ONE shared writer so every qty path leaves a line (consumption-ledger.md
    // §7.3). Best-effort — a ledger hiccup must not fail the stock change.
    try {
      await recordConsumption(db, {
        partId: updated.id,
        delta: parsed.data.delta,
        reason: parsed.data.reason ?? null,
        sourceKind: parsed.data.source_kind ?? null,
        sourceId: parsed.data.source_id ?? null,
      });
    } catch (e) {
      console.error("[inventory.stock-adjust] ledger write failed:", (e as Error).message);
    }

    await platform().activity.log({
      orgId: ctx.org.id,
      userId: session.id,
      action: "stock_adjusted",
      ref: { module: "inventory", entityType: "part", entityId: updated.id },
      diff: { delta: parsed.data.delta, reason: parsed.data.reason ?? null, new_qty: updated.qty },
    });
    // Await so any wires (e.g. "flip task deps that depended on
    // this part") have run before the client gets its 200. A client
    // that immediately re-reads the task sees satisfied=true.
    await platform().events.emit("inventory.stock.changed", {
      orgId: ctx.org.id,
      partId: updated.id,
      delta: parsed.data.delta,
      newQty: Number(updated.qty),
    });

    // Deliberately counting copies IS stock signal — a stock-adjust on a lean
    // catalog item ("I have another one") latches the instance like any other
    // stock-shaped write.
    await maybeLatchStock(req, ctx.org.id, { qty: updated.qty });

    // Low-stock signal: on a DECREASE that lands at/below min_qty, fire
    // inventory.stock.low (manifest-declared; this is its emit point). Wires
    // like the food-cluster "running low → shopping list" hang off it. Only on
    // a decrease, so re-stocking doesn't re-alert.
    const newQty = Number(updated.qty);
    const minQty = updated.min_qty == null ? null : Number(updated.min_qty);
    if (parsed.data.delta < 0 && minQty != null && minQty > 0 && newQty <= minQty) {
      await platform().events.emit("inventory.stock.low", {
        orgId: ctx.org.id,
        partId: updated.id,
        newQty,
        minQty,
      });
    }

    res.json({ ...updated, qty: newQty });
  }),
);
