// Catalog CRUD + CSV import + entry browsing.
//
// Catalogs are imported reference datasets. The user's own entities
// (parts, machines, etc.) match against rows inside them via
// entity_pairings with relationship_kind='matches'.

import { Router } from "express";
import { z } from "zod";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { sessionUser, tenantContext, tenantDb } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";

export const catalogsRouter = Router({ mergeParams: true });

// One of the small fixed set of built-in renderers Cobblr's web UI
// knows how to draw. Catalogs (and later: entity kinds, bundle
// presentation overrides) declare which renderer to use per field
// via `field_renderers` below. Bundles intentionally don't ship
// rendering code — the platform owns the renderer library; bundles
// own the declarative mapping. See FIELD_RENDERERS in
// web/src/components/CatalogFieldValue.tsx.
const FieldRenderer = z.enum([
  "text",        // default — String(value)
  "color-hex",   // "0033B2" → swatch + uppercase hex
  "image-url",   // URL → thumbnail
  "url-link",    // URL → clickable link
  "year",        // 1965 → "1965"
  "boolean",     // "True"/"true"/1/0 → ✓ / ✕
  "code",        // monospace + bg, for SKUs / model numbers
]);

const SchemaConfig = z.object({
  id_column: z.string().optional(),
  title_column: z.string().optional(),
  image_column: z.string().optional(),
  subtitle_column: z.string().optional(),
  description_column: z.string().optional(),
  /** Optional per-field renderer overrides — `{rgb: "color-hex",
   *  img_url: "image-url"}`. The catalog detail UI picks the
   *  renderer keyed by the payload field name. Unknown fields fall
   *  back to plain text. */
  field_renderers: z.record(FieldRenderer).optional(),
  /** Optional per-field display-label overrides. Rebrickable's
   *  payloads use database-y short names (`is_trans`, `num_parts`,
   *  `part_cat_id`); this map lets a bundle author render them as
   *  "Transparent", "Pieces", "Category" without renaming the
   *  source column on import. */
  field_labels: z.record(z.string()).optional(),
  /** Replaces the card's image slot with a renderer drawing
   *  `payload[hero_field]`. E.g. for Rebrickable colors, set
   *  hero_field=rgb + hero_renderer=color-hex and the card shows a
   *  big swatch where the photo would be. Bundles use this to
   *  inject domain-specific visual identity without shipping JS. */
  hero_field: z.string().optional(),
  hero_renderer: FieldRenderer.optional(),
  /** Opt out of the cross-catalog search endpoint. Catalogs that
   *  are huge (McMaster scale) or otherwise not bindable to user
   *  entities can set this so the quick-add typeahead doesn't pull
   *  them in. Default false. */
  exclude_from_global_search: z.boolean().optional(),
  /** Which entity kinds this catalog is meaningful to match against.
   *  Picker filters by source_kind ∈ bindable_to_kinds (or shows the
   *  catalog when this list is omitted). Lets the Rebrickable bundle
   *  declare "I only bind to inventory:part" so users matching a
   *  machine don't see Lego parts in the picker. */
  bindable_to_kinds: z.array(z.string()).optional(),
  /** Stable semantic identifier for this catalog's role in the
   *  domain. Lets other modules look up "the canonical sets catalog"
   *  without coupling to a specific bundle id. Convention:
   *  `<vendor>.<kind>` lowercase. Examples:
   *    lego.set / lego.part / lego.minifig / lego.color / lego.bom
   *    mcmaster.part
   *    discogs.release
   *    usda.food
   *  First-match wins per workspace — a workspace can only have one
   *  canonical catalog per semantic_type. See 2026-05-25-audit.md S5.
   */
  semantic_type: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/).optional(),
});

const CatalogCreate = z.object({
  name: z.string().min(1).max(160),
  description: z.string().max(2000).optional(),
  source_url: z.string().url().max(2000).optional(),
  puller_id: z.string().max(80).optional(),
  schema: SchemaConfig.optional(),
});

const CatalogUpdate = CatalogCreate.partial();

const ListQuery = z.object({
  q: z.string().optional(),
  /** Exact match on entry's external_id (the catalog's canonical id).
   *  Useful when scripts know the source key — e.g. matching a part
   *  to a specific Rebrickable set number. */
  external_id: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

catalogsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const rows = await db
      .selectFrom("core_catalogs_catalogs")
      .selectAll()
      .orderBy("name")
      .execute();
    res.json({ items: rows });
  }),
);

// Cross-catalog search — one call, every catalog in the workspace.
// Used by the catalog-aware quick-add typeahead on entity create
// forms (NewPartDialog etc.) so the user types "millenn" once and
// sees results from Rebrickable sets + minifigs + anything else.
//
// Each catalog can have its own title_column, so we read the catalog
// rows first to discover them, then fan out one per-catalog query
// substituting the right column into the LIKE filter. Catalogs can
// opt out via schema.exclude_from_global_search=true (e.g. the BOM
// table whose 5M rows would drown out the real catalogs).
//
// MUST be declared before any "/:id" route — Express matches in
// declaration order and "search" would otherwise be parsed as an id.
const SearchQuery = z.object({
  q: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(60).default(30),
  /** Restrict to specific catalog ids if the caller knows which
   *  catalogs are relevant (e.g. inventory:part create form might
   *  only want catalogs whose entries are bindable to parts). */
  catalog_ids: z.string().optional(), // comma-separated
  /** When set, the picker filters out catalogs whose
   *  `schema.bindable_to_kinds` is declared and doesn't include this
   *  source kind. Lets NewPartDialog hit /search?source_kind=inventory:part
   *  and only see Rebrickable + other Lego catalogs. */
  source_kind: z.string().optional(),
});

// Lookup a catalog by its semantic_type. The cross-module discovery
// surface — a different module asks "give me the canonical lego.set
// catalog" and gets a single row, regardless of which bundle
// installed it. Returns null if no catalog declares that type.
// See 2026-05-25-audit.md S5.
catalogsRouter.get(
  "/by-semantic-type/:semantic_type",
  asyncHandler(async (req, res) => {
    const semType = req.params.semantic_type;
    if (!semType) {
      res.status(400).json({
        error: { code: "missing_semantic_type", message: "semantic_type required" },
      });
      return;
    }
    const db = tenantDb(req);
    const row = await db
      .selectFrom("core_catalogs_catalogs")
      .selectAll()
      .where(
        sql<boolean>`schema->>'semantic_type' = ${semType}`,
      )
      .limit(1)
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({
        error: {
          code: "no_catalog_for_semantic_type",
          message: `No catalog declares semantic_type='${semType}' in this workspace.`,
        },
      });
      return;
    }
    res.json(row);
  }),
);

catalogsRouter.get(
  "/search",
  asyncHandler(async (req, res) => {
    const parsed = SearchQuery.safeParse(req.query);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const like = `%${parsed.data.q.toLowerCase()}%`;
    const restrict = parsed.data.catalog_ids
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    let catalogsQuery = db
      .selectFrom("core_catalogs_catalogs")
      .select(["id", "name", "schema", "entry_count"]);
    if (restrict && restrict.length > 0) {
      catalogsQuery = catalogsQuery.where("id", "in", restrict);
    }
    const catalogs = (await catalogsQuery.execute()).filter((c) => {
      const s = (c.schema ?? {}) as Record<string, unknown>;
      if (s.exclude_from_global_search === true) return false;
      // Apply bindable_to_kinds filter when the caller supplied a
      // source_kind. Catalogs that don't declare bindings are kept
      // (workspace-authored catalogs without explicit scoping).
      if (parsed.data.source_kind && Array.isArray(s.bindable_to_kinds)) {
        // Declared at all → gate strictly. Empty array means
        // "binds to nothing" (taxonomies); omit the field entirely
        // to mean "binds to everything" (legacy / generic catalogs).
        const kinds = s.bindable_to_kinds as string[];
        if (!kinds.includes(parsed.data.source_kind)) return false;
      }
      return true;
    });
    if (catalogs.length === 0) {
      res.json({ items: [] });
      return;
    }

    const results: Array<{
      id: string;
      catalog_id: string;
      catalog_name: string;
      external_id: string;
      payload: Record<string, unknown>;
      title: string;
      title_column: string;
    }> = [];
    // Pull a generous per-catalog slice so client-side ranking has
    // room: a typed part-number query alphabetically lands between
    // 30014 and 30019, so a stingy limit risks dropping the exact
    // hit ("3001") on the floor. 20 is plenty for 6 catalogs.
    const perCatalogLimit = Math.max(
      20,
      Math.ceil(parsed.data.limit / catalogs.length),
    );
    await Promise.all(
      catalogs.map(async (c) => {
        const s = (c.schema ?? {}) as Record<string, unknown>;
        const titleColumn = String(s.title_column ?? "name");
        // Match on title_column OR on the canonical external_id —
        // both are valid lookups (the user might type a set number or
        // a name).
        const rows = await db
          .selectFrom("core_catalogs_entries")
          .select(["id", "catalog_id", "external_id", "payload"])
          .where("catalog_id", "=", c.id)
          .where(
            sql<boolean>`(lower(payload->>${titleColumn}) like ${like} or lower(external_id) like ${like})`,
          )
          .orderBy(sql<string>`payload->>${titleColumn}` as never)
          .limit(perCatalogLimit)
          .execute();
        for (const r of rows) {
          const title = String(
            (r.payload as Record<string, unknown>)[titleColumn] ?? r.external_id,
          );
          results.push({
            id: r.id,
            catalog_id: r.catalog_id,
            catalog_name: c.name,
            external_id: r.external_id,
            payload: r.payload as Record<string, unknown>,
            title,
            title_column: titleColumn,
          });
        }
      }),
    );

    // Rank: external_id-prefix (the user typed a part #) >
    // title-prefix > word-start > substring. Alphabetical within a
    // tier so paging is stable.
    const q = parsed.data.q.toLowerCase();
    const rank = (hit: {
      title: string;
      external_id: string;
    }): number => {
      const t = hit.title.toLowerCase();
      const eid = hit.external_id.toLowerCase();
      if (eid === q) return 0;
      if (eid.startsWith(q)) return 1;
      if (t.startsWith(q)) return 2;
      if (t.includes(` ${q}`)) return 3;
      return 4;
    };
    results.sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== rb) return ra - rb;
      return a.title.localeCompare(b.title);
    });
    res.json({ items: results.slice(0, parsed.data.limit) });
  }),
);

catalogsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const row = await db
      .selectFrom("core_catalogs_catalogs")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "catalog not found" } });
      return;
    }
    res.json(row);
  }),
);

catalogsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = CatalogCreate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const created = await db
      .insertInto("core_catalogs_catalogs")
      .values({
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        source_url: parsed.data.source_url ?? null,
        puller_id: parsed.data.puller_id ?? null,
        schema: sql`${JSON.stringify(parsed.data.schema ?? {})}::jsonb` as never,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    void platform().events.emit("core-catalogs.catalog.created", {
      orgId: ctx.org.id,
      catalogId: created.id,
      name: created.name,
    });
    res.status(201).json(created);
  }),
);

catalogsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const parsed = CatalogUpdate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.description !== undefined)
      patch.description = parsed.data.description;
    if (parsed.data.source_url !== undefined)
      patch.source_url = parsed.data.source_url;
    if (parsed.data.puller_id !== undefined)
      patch.puller_id = parsed.data.puller_id;
    if (parsed.data.schema !== undefined)
      patch.schema = sql`${JSON.stringify(parsed.data.schema)}::jsonb`;
    const updated = await db
      .updateTable("core_catalogs_catalogs")
      .set(patch as never)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
    if (!updated) {
      res.status(404).json({ error: { code: "not_found", message: "catalog not found" } });
      return;
    }
    void platform().events.emit("core-catalogs.catalog.updated", {
      orgId: ctx.org.id,
      catalogId: id,
    });
    res.json(updated);
  }),
);

catalogsRouter.delete(
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
    const result = await db
      .deleteFrom("core_catalogs_catalogs")
      .where("id", "=", id)
      .executeTakeFirst();
    if (Number(result.numDeletedRows) === 0) {
      res.status(404).json({ error: { code: "not_found", message: "catalog not found" } });
      return;
    }
    void platform().events.emit("core-catalogs.catalog.deleted", {
      orgId: ctx.org.id,
      catalogId: id,
    });
    res.status(204).end();
  }),
);

// CSV import — the built-in v0.1 puller. POST a CSV body; importer
// reads catalog.schema for column mappings, upserts entries by
// (catalog_id, external_id).
const CsvImportBody = z.object({
  csv: z.string().min(1).max(20_000_000), // 20MB cap; revisit if real datasets need more
  /** Override the catalog's stored schema for this import only. */
  schema: SchemaConfig.optional(),
});

interface ParsedRow {
  external_id: string;
  payload: Record<string, unknown>;
}

function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  // Minimal RFC-4180-ish CSV parser. Handles quoted fields with
  // embedded commas and doubled-quote escapes. Doesn't try to be
  // a full CSV library — real-world catalog CSVs (Rebrickable,
  // McMaster, USDA) all fit this shape.
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      cur.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (ch === "\r") {
      i += 1;
      continue;
    }
    if (ch === "\n") {
      cur.push(field);
      rows.push(cur);
      cur = [];
      field = "";
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field.length > 0 || cur.length > 0) {
    cur.push(field);
    rows.push(cur);
  }
  const headers = rows.shift() ?? [];
  return { headers, rows };
}

catalogsRouter.post(
  "/:id/import-csv",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const parsed = CsvImportBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const catalog = await db
      .selectFrom("core_catalogs_catalogs")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!catalog) {
      res.status(404).json({ error: { code: "not_found", message: "catalog not found" } });
      return;
    }

    const { headers, rows } = parseCsv(parsed.data.csv);
    if (headers.length === 0) {
      res.status(400).json({
        error: { code: "empty_csv", message: "CSV had no header row." },
      });
      return;
    }
    const schemaConfig = {
      ...(catalog.schema as Record<string, unknown>),
      ...(parsed.data.schema ?? {}),
    } as z.infer<typeof SchemaConfig>;
    const idCol = schemaConfig.id_column ?? headers[0]!;
    const idIdx = headers.indexOf(idCol);
    if (idIdx < 0) {
      res.status(400).json({
        error: {
          code: "id_column_missing",
          message: `CSV has no column named '${idCol}'. Available: ${headers.join(", ")}`,
        },
      });
      return;
    }

    const parsedRows: ParsedRow[] = [];
    for (const row of rows) {
      const externalId = (row[idIdx] ?? "").trim();
      if (!externalId) continue;
      const payload: Record<string, unknown> = {};
      for (let j = 0; j < headers.length; j++) {
        if (j === idIdx) continue;
        const v = row[j];
        if (v !== undefined && v !== "") payload[headers[j]!] = v;
      }
      parsedRows.push({ external_id: externalId, payload });
    }

    if (parsedRows.length === 0) {
      res.json({ imported: 0, total: 0, schema_used: schemaConfig });
      return;
    }

    // Upsert in batches so a 50k-row import doesn't try to ship one
    // monstrous statement.
    const BATCH = 500;
    let upserted = 0;
    for (let start = 0; start < parsedRows.length; start += BATCH) {
      const batch = parsedRows.slice(start, start + BATCH);
      await db
        .insertInto("core_catalogs_entries")
        .values(
          batch.map((r) => ({
            catalog_id: id,
            external_id: r.external_id,
            payload: sql`${JSON.stringify(r.payload)}::jsonb` as never,
          })),
        )
        .onConflict((oc) =>
          oc.columns(["catalog_id", "external_id"]).doUpdateSet({
            payload: sql`excluded.payload` as never,
            updated_at: new Date(),
          }),
        )
        .execute();
      upserted += batch.length;
    }

    // Cache the count + bump schema if we overrode it.
    const { count } = (await db
      .selectFrom("core_catalogs_entries")
      .select((eb) => eb.fn.countAll().as("count"))
      .where("catalog_id", "=", id)
      .executeTakeFirstOrThrow()) as { count: string | number };
    await db
      .updateTable("core_catalogs_catalogs")
      .set({
        entry_count: Number(count),
        last_sync_at: new Date(),
        schema: sql`${JSON.stringify(schemaConfig)}::jsonb` as never,
        updated_at: new Date(),
      } as never)
      .where("id", "=", id)
      .execute();

    void platform().events.emit("core-catalogs.catalog.synced", {
      orgId: ctx.org.id,
      catalogId: id,
      imported: upserted,
      total: Number(count),
    });

    res.json({
      imported: upserted,
      total: Number(count),
      schema_used: schemaConfig,
    });
  }),
);

// Entry listing within a catalog — paginated, optionally
// title-filtered. Used by both the entry browser UI and the match
// picker modal.
const EntryListQuery = ListQuery;

catalogsRouter.get(
  "/:id/entries",
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const parsed = EntryListQuery.safeParse(req.query);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const catalog = await db
      .selectFrom("core_catalogs_catalogs")
      .select(["id", "schema"])
      .where("id", "=", id)
      .executeTakeFirst();
    if (!catalog) {
      res.status(404).json({ error: { code: "not_found", message: "catalog not found" } });
      return;
    }
    const titleColumn =
      (catalog.schema as Record<string, unknown>).title_column ?? "name";
    let query = db
      .selectFrom("core_catalogs_entries")
      .selectAll()
      .where("catalog_id", "=", id);
    if (parsed.data.external_id) {
      query = query.where("external_id", "=", parsed.data.external_id);
    }
    if (parsed.data.q) {
      const like = `%${parsed.data.q.toLowerCase()}%`;
      query = query.where(
        sql<boolean>`lower(payload->>${String(titleColumn)}) like ${like}`,
      );
    }
    const items = await query
      .orderBy(sql<string>`payload->>${String(titleColumn)}` as never)
      .limit(parsed.data.limit)
      .offset(parsed.data.offset)
      .execute();
    res.json({ items, title_column: titleColumn });
  }),
);

catalogsRouter.get(
  "/:id/entries/:entryId",
  asyncHandler(async (req, res) => {
    const catalogId = req.params.id;
    const entryId = req.params.entryId;
    if (!catalogId || !entryId) {
      res.status(400).json({ error: { code: "missing_id", message: "ids required" } });
      return;
    }
    const db = tenantDb(req);
    const row = await db
      .selectFrom("core_catalogs_entries")
      .selectAll()
      .where("catalog_id", "=", catalogId)
      .where("id", "=", entryId)
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "entry not found" } });
      return;
    }
    res.json(row);
  }),
);

// Manual sync trigger. For CSV catalogs (no puller_id), no-op + 400.
// For pullable catalogs (v0.3), kicks off a core-queue job.
catalogsRouter.post(
  "/:id/sync",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const db = tenantDb(req);
    const catalog = await db
      .selectFrom("core_catalogs_catalogs")
      .select(["id", "puller_id"])
      .where("id", "=", id)
      .executeTakeFirst();
    if (!catalog) {
      res.status(404).json({ error: { code: "not_found", message: "catalog not found" } });
      return;
    }
    if (!catalog.puller_id) {
      res.status(400).json({
        error: {
          code: "no_puller",
          message:
            "Catalog has no registered puller. Re-import the CSV manually to refresh.",
        },
      });
      return;
    }
    // v0.3: enqueue a sync job that calls the registered puller.
    // Not implemented yet — return 501 so callers don't silently
    // think a sync happened.
    res.status(501).json({
      error: {
        code: "not_implemented",
        message: `Live-API pullers are v0.3 work. Puller '${catalog.puller_id}' is declared on this catalog but the runtime isn't built yet.`,
      },
    });
    return;
    // intentionally unreachable
    void sessionUser;
  }),
);
