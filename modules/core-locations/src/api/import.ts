// Locations CSV import/export — paste/upload a CSV, PREVIEW exactly what will
// happen (create vs update vs skip, parent resolution), then commit. Generic:
//   - Known columns map to fields: name, short_name, kind ('area'|'container'),
//     parent (references another row by the chosen match key).
//   - EVERY other column drops into metadata[column] verbatim — nothing is
//     special-cased (no app/migration concepts baked into the platform).
//   - `match_on` is a column YOU choose (default 'name'); a row whose match value
//     already exists is an UPDATE, otherwise a CREATE. `parent` resolves against
//     the same key, so hierarchy imports in one pass.
//
// Two endpoints: POST /locations/import (dry_run preview | commit) and
// GET /locations/export (current locations → CSV).

import { Router } from "express";
import { z } from "zod";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { ADMIN_TIER } from "@cobblr/platform-contract/org-roles";
import { csvCell, parseCsv, unguardCsvText } from "@cobblr/platform-contract/csv";
import { sessionUser, tenantContext, tenantDb } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { planByKey, planByName, PATH_SEPARATOR } from "./import-plan.js";
import { lockTree, placesOffTheTree } from "./place-move.js";

class ImportLoop extends Error {
  readonly names: string[];
  constructor(names: string[]) {
    super("import makes a loop");
    this.names = names;
  }
}

export const locationsImportRouter = Router({ mergeParams: true });

const KNOWN = new Set(["name", "short_name", "kind", "parent"]);

interface ParsedRow {
  row_number: number;
  name: string;
  short_name: string | null;
  kind: "area" | "container";
  parent_key: string | null; // the parent's match-key value
  match_value: string | null; // this row's match-key value
  metadata: Record<string, string>;
}

export function parseLocations(csv: string, matchOn: string): { headers: string[]; rows: ParsedRow[]; errors: { row_number: number; message: string }[] } {
  let raw: string[][];
  try {
    raw = parseCsv(csv, { strict: true }).filter((r) => r.some((f) => f.trim() !== ""));
  } catch (e) {
    return { headers: [], rows: [], errors: [{ row_number: 0, message: (e as Error).message }] };
  }
  if (raw.length === 0) return { headers: [], rows: [], errors: [] };
  const headers = raw[0]!.map((h) => h.trim());
  const idx = (name: string) => headers.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  const nameI = idx("name");
  const rows: ParsedRow[] = [];
  const errors: { row_number: number; message: string }[] = [];
  for (let r = 1; r < raw.length; r++) {
    const cells = raw[r]!;
    const get = (i: number) => (i >= 0 && i < cells.length ? unguardCsvText(cells[i]!.trim()) : "");
    const name = nameI >= 0 ? get(nameI) : "";
    if (!name) { errors.push({ row_number: r, message: "Missing name, skipped" }); continue; }
    const kindRaw = get(idx("kind")).toLowerCase();
    const kind = kindRaw === "container" ? "container" : "area";
    const metadata: Record<string, string> = {};
    headers.forEach((h, ci) => {
      if (!KNOWN.has(h.toLowerCase())) {
        const v = get(ci);
        if (v) metadata[h] = v;
      }
    });
    const matchCell = matchOn.toLowerCase() === "name" ? name : get(idx(matchOn));
    rows.push({
      row_number: r,
      name,
      short_name: get(idx("short_name")) || null,
      kind,
      parent_key: get(idx("parent")) || null,
      match_value: matchCell || null,
      metadata,
    });
  }
  return { headers, rows, errors };
}

const ImportBody = z.object({
  csv: z.string().min(1).max(5_000_000),
  match_on: z.string().min(1).max(120).default("name"),
  dry_run: z.boolean().default(false),
});

// Build the existing-location lookup keyed by the chosen match column.

// AI-REACH: exempt — a bulk import of up to 5 MB of CSV; as an action
// argument the whole file would be ledgered and put on a confirm card. The
// assistant adds places through create_records, one undoable set of up to 200
locationsImportRouter.post(
  "/import",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, ...ADMIN_TIER)) return;
    const parsed = ImportBody.safeParse(req.body);
    if (!parsed.success) return void badBody(res, parsed.error);
    const { csv, match_on } = parsed.data;
    const db = tenantDb(req);

    const { headers, rows, errors } = parseLocations(csv, match_on);
    const existing = (await db.selectFrom("core_locations_locations").select(["id", "name", "parent_id", "metadata"]).execute()).map((l) => ({
      ...l,
      metadata: (l.metadata as Record<string, unknown> | null) ?? null,
    }));
    // ONE plan for the preview and the commit, so the preview can never
    // promise what the commit does differently (import-plan.ts).
    const plan = match_on.toLowerCase() === "name" ? planByName(rows, existing) : planByKey(rows, existing, match_on);
    const preview = plan.rows.map((p) => ({
      row_number: p.row_number,
      name: p.name,
      short_name: p.short_name,
      kind: p.kind,
      match_value: p.match_value,
      action: p.action,
      parent: p.parent,
      path: p.path,
      metadata: p.metadata,
      error: p.error,
    }));
    const summary = {
      create: preview.filter((p) => p.action === "create" && !p.error).length,
      update: preview.filter((p) => p.action === "update" && !p.error).length,
      unresolved_parents: preview.filter((p) => p.parent && !p.parent.resolved).length,
      blocked: plan.blocking.length,
    };

    if (parsed.data.dry_run || rows.length === 0) {
      res.json({ match_on, detected_headers: headers, rows: preview, errors, blocking: plan.blocking, summary, committed: 0 });
      return;
    }
    if (plan.blocking.length > 0) {
      res.status(409).json({
        error: {
          code: "import_rows_blocked",
          message: `${plan.blocking.length} row${plan.blocking.length === 1 ? "" : "s"} cannot be imported as written: ${plan.blocking
            .slice(0, 3)
            .map((b) => `row ${b.row_number}, ${b.message}`)
            .join("; ")}`,
          blocking: plan.blocking,
        },
      });
      return;
    }

    // SIBLING-DUP-OK: an import writes the places the person's own file
    // names, under the parents the plan resolved; two places may share a name
    // when their paths differ, which is the case the plan exists for.
    const ctx = tenantContext(req);
    const session = sessionUser(req);
    let created = 0;
    let updated = 0;

    const offTree = await db.transaction().execute(async (trx) => {
      await lockTree(trx);
      const lostBefore = new Set((await placesOffTheTree(trx)).map((p) => p.id));
      const idOfRow = new Map<number, string>();
      for (const i of plan.order) {
        const p = plan.rows[i]!;
        const ref = p.parentRef;
        const parentId = ref ? ("existing" in ref ? ref.existing : idOfRow.get(ref.row) ?? null) : null;
        const setParent = p.parent ? { parent_id: parentId } : {};
        if (p.action === "update" && p.id) {
          await trx
            .updateTable("core_locations_locations")
            .set({ name: p.name, short_name: p.short_name, kind: p.kind, ...setParent, metadata: sql`metadata || ${JSON.stringify(p.metadata)}::jsonb` })
            .where("id", "=", p.id)
            .execute();
          idOfRow.set(i, p.id);
          updated++;
        } else {
          const ins = await trx
            .insertInto("core_locations_locations")
            .values({ name: p.name, short_name: p.short_name, kind: p.kind, parent_id: parentId, metadata: sql`${JSON.stringify(p.metadata)}::jsonb` })
            .returning("id")
            .executeTakeFirstOrThrow();
          idOfRow.set(i, ins.id);
          created++;
        }
      }
      // A row may move a place under one that is inside it; the whole file
      // is refused then, before any of it lands (place-move.ts).
      const lost = (await placesOffTheTree(trx)).filter((p) => !lostBefore.has(p.id));
      if (lost.length > 0) throw new ImportLoop(lost.slice(0, 5).map((p) => p.name));
      await trx.executeQuery(sql`
        with recursive tree as (
          select id, 0 as d from core_locations_locations where parent_id is null
          union all
          select c.id, t.d + 1 from core_locations_locations c join tree t on c.parent_id = t.id
        )
        update core_locations_locations l set depth = tree.d from tree where tree.id = l.id
      `.compile(trx));
    }).then((): string[] => []).catch((e: unknown) => {
      if (e instanceof ImportLoop) return e.names;
      throw e;
    });
    if (offTree.length > 0) {
      res.status(409).json({
        error: { code: "cycle", message: `This file puts ${offTree.join(", ")} inside a place that is inside it, so nothing was imported.` },
      });
      return;
    }

    await platform().activity.log({ orgId: ctx.org.id, userId: session.id, action: "locations_imported", ref: { module: "core-locations", entityType: "location", entityId: "" }, diff: { created, updated, match_on } }).catch(() => {});
    res.json({ committed: created + updated, created, updated, errors });
  }),
);

// Export current locations as CSV (so you can see the shape / round-trip).
locationsImportRouter.get(
  "/export",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const db = tenantDb(req);
    const locs = await db.selectFrom("core_locations_locations").select(["id", "name", "short_name", "kind", "parent_id", "metadata"]).orderBy("depth").orderBy("name").execute();
    const byId = new Map(locs.map((l) => [l.id, l]));
    // Gather all metadata keys present, so they each get a column.
    const metaKeys = new Set<string>();
    for (const l of locs) for (const k of Object.keys((l.metadata as Record<string, unknown>) ?? {})) metaKeys.add(k);
    // A field this reader may not read is neither a column nor a value.
    const ctx = tenantContext(req);
    const hidden = await platform().entities.hiddenFields(ctx.org.id, "core-locations:location", { userId: sessionUser(req)?.id, role: ctx.role });
    for (const k of hidden) metaKeys.delete(k);
    const headers = ["name", "short_name", "kind", "parent", ...metaKeys];
    const lines = [headers.map(csvCell).join(",")];
    // A parent is written by name, or by its path when its name is not unique,
    // so the file imports back into the same tree (import-plan.ts).
    const nameCount = new Map<string, number>();
    for (const l of locs) nameCount.set(l.name.toLowerCase(), (nameCount.get(l.name.toLowerCase()) ?? 0) + 1);
    const pathOf = (id: string): string => {
      const names: string[] = [];
      const seen = new Set<string>();
      for (let cur = byId.get(id); cur && !seen.has(cur.id); cur = cur.parent_id ? byId.get(cur.parent_id) : undefined) {
        seen.add(cur.id);
        names.unshift(cur.name);
      }
      return names.join(PATH_SEPARATOR);
    };
    for (const l of locs) {
      const p = l.parent_id ? byId.get(l.parent_id) : undefined;
      const parent = !p ? "" : (nameCount.get(p.name.toLowerCase()) ?? 0) > 1 ? pathOf(p.id) : p.name;
      const meta = (l.metadata as Record<string, unknown>) ?? {};
      lines.push([l.name, l.short_name ?? "", l.kind, parent, ...[...metaKeys].map((k) => meta[k])].map(csvCell).join(","));
    }
    res.setHeader("content-type", "text/csv");
    res.setHeader("content-disposition", 'attachment; filename="locations.csv"');
    res.send(lines.join("\n"));
  }),
);
