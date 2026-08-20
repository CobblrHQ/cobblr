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
import { sessionUser, tenantContext, tenantDb } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";

export const locationsImportRouter = Router({ mergeParams: true });

const KNOWN = new Set(["name", "short_name", "kind", "parent"]);

// ── tiny CSV parser (RFC-4180-ish: quoted fields, "" escapes, CRLF) ──
function parseCsvRaw(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
    else if (c === "\r") { /* skip */ }
    else cur += c;
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

interface ParsedRow {
  row_number: number;
  name: string;
  short_name: string | null;
  kind: "area" | "container";
  parent_key: string | null; // the parent's match-key value
  match_value: string | null; // this row's match-key value
  metadata: Record<string, string>;
}

function parseLocations(csv: string, matchOn: string): { headers: string[]; rows: ParsedRow[]; errors: { row_number: number; message: string }[] } {
  const raw = parseCsvRaw(csv);
  if (raw.length === 0) return { headers: [], rows: [], errors: [] };
  const headers = raw[0]!.map((h) => h.trim());
  const idx = (name: string) => headers.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  const nameI = idx("name");
  const rows: ParsedRow[] = [];
  const errors: { row_number: number; message: string }[] = [];
  for (let r = 1; r < raw.length; r++) {
    const cells = raw[r]!;
    const get = (i: number) => (i >= 0 && i < cells.length ? cells[i]!.trim() : "");
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
async function existingByKey(db: ReturnType<typeof tenantDb>, matchOn: string) {
  const locs = await db.selectFrom("core_locations_locations").select(["id", "name", "metadata"]).execute();
  const byKey = new Map<string, string>(); // match value (lower) → id
  for (const l of locs) {
    const key = matchOn.toLowerCase() === "name" ? l.name : ((l.metadata as Record<string, unknown>)?.[matchOn] as string | undefined);
    if (key) byKey.set(String(key).toLowerCase(), l.id);
  }
  return byKey;
}

// AI-REACH: takes or produces a file (multipart or binary), which an action cannot carry
locationsImportRouter.post(
  "/import",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = ImportBody.safeParse(req.body);
    if (!parsed.success) return void badBody(res, parsed.error);
    const { csv, match_on } = parsed.data;
    const db = tenantDb(req);

    const { headers, rows, errors } = parseLocations(csv, match_on);
    const existing = await existingByKey(db, match_on);
    // In-batch match keys (so a parent defined later in the file still resolves,
    // and a row that matches an existing one is an update).
    const batchKeys = new Set<string>();
    for (const r of rows) if (r.match_value) batchKeys.add(r.match_value.toLowerCase());

    // Classify each row + resolve parent (against existing OR in-batch keys).
    const preview = rows.map((r) => {
      const mk = r.match_value?.toLowerCase();
      const action: "create" | "update" = mk && existing.has(mk) ? "update" : "create";
      let parent: { key: string; resolved: boolean } | null = null;
      if (r.parent_key) {
        const pk = r.parent_key.toLowerCase();
        parent = { key: r.parent_key, resolved: existing.has(pk) || batchKeys.has(pk) };
      }
      return { row_number: r.row_number, name: r.name, short_name: r.short_name, kind: r.kind, match_value: r.match_value, action, parent, metadata: r.metadata };
    });

    if (parsed.data.dry_run || rows.length === 0) {
      res.json({
        match_on,
        detected_headers: headers,
        rows: preview,
        errors,
        summary: { create: preview.filter((p) => p.action === "create").length, update: preview.filter((p) => p.action === "update").length, unresolved_parents: preview.filter((p) => p.parent && !p.parent.resolved).length },
        committed: 0,
      });
      return;
    }

    // SIBLING-DUP-OK: an import matches on the user's OWN key (match_value),
    // chosen on the mapping screen, and parents are linked in pass 2 — so at
    // insert time a row has no parent to be a sibling under yet. Refusing on
    // name here would drop rows the user can see in their own file and expects
    // to arrive. Rows that collide by name are the import's business, and it
    // reports created/updated counts for exactly that reason.
    //
    // ── Commit. Pass 1: upsert every row (parent linked in pass 2 once all ids
    //    exist). Match key → id map grows as we go.
    const ctx = tenantContext(req);
    const session = sessionUser(req);
    const keyToId = new Map(existing); // seed with existing
    let created = 0;
    let updated = 0;

    await db.transaction().execute(async (trx) => {
      for (const r of rows) {
        const mk = r.match_value?.toLowerCase();
        const metaWithKey = { ...r.metadata }; // metadata columns include the match key already
        if (mk && existing.has(mk)) {
          const id = existing.get(mk)!;
          await trx.updateTable("core_locations_locations").set({ name: r.name, short_name: r.short_name, kind: r.kind, metadata: sql`metadata || ${JSON.stringify(metaWithKey)}::jsonb` }).where("id", "=", id).execute();
          keyToId.set(mk, id);
          updated++;
        } else {
          const ins = await trx.insertInto("core_locations_locations").values({ name: r.name, short_name: r.short_name, kind: r.kind, metadata: sql`${JSON.stringify(metaWithKey)}::jsonb` }).returning("id").executeTakeFirstOrThrow();
          if (mk) keyToId.set(mk, ins.id);
          created++;
        }
      }
      // Pass 2: link parents now that every key has an id.
      for (const r of rows) {
        if (!r.parent_key || !r.match_value) continue;
        const myId = keyToId.get(r.match_value.toLowerCase());
        const parentId = keyToId.get(r.parent_key.toLowerCase());
        if (myId && parentId && myId !== parentId) {
          await trx.updateTable("core_locations_locations").set({ parent_id: parentId }).where("id", "=", myId).execute();
        }
      }
    });
    // Recompute depths after the parent links land (cheap recursive pass).
    await db.executeQuery(sql`
      with recursive tree as (
        select id, 0 as d from core_locations_locations where parent_id is null
        union all
        select c.id, t.d + 1 from core_locations_locations c join tree t on c.parent_id = t.id
      )
      update core_locations_locations l set depth = tree.d from tree where tree.id = l.id
    `.compile(db)).catch(() => {});

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
    const headers = ["name", "short_name", "kind", "parent", ...metaKeys];
    const esc = (v: unknown) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [headers.join(",")];
    for (const l of locs) {
      const parent = l.parent_id ? byId.get(l.parent_id)?.name ?? "" : "";
      const meta = (l.metadata as Record<string, unknown>) ?? {};
      lines.push([l.name, l.short_name ?? "", l.kind, parent, ...[...metaKeys].map((k) => meta[k])].map(esc).join(","));
    }
    res.setHeader("content-type", "text/csv");
    res.setHeader("content-disposition", 'attachment; filename="locations.csv"');
    res.send(lines.join("\n"));
  }),
);
