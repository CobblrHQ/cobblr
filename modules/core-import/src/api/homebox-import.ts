// Homebox import — parse a Homebox CSV/TSV export and fan the records out to
// the modules that own them, over their PUBLIC APIs carrying the caller's bearer
// (never a cross-module import — the same isolation-clean pattern core-scan's
// importer uses to reach core-files):
//   • location paths  → core-locations  (create the tree, reuse existing nodes)
//   • items           → inventory       (parts, with all HomeBox-parity fields)
//   • labels          → core-tags       (attach-by-name; creates the tag)
//
//   POST /homebox/preview  — parse + summary, never writes
//   POST /homebox          — commit
//
// Requires Inventory + Locations enabled (it imports INTO them); a clean 400
// says so rather than half-importing. Not idempotent for items (every row is a
// new part, like inventory's own CSV import); locations DO reuse an existing
// same-path node so a re-run doesn't clone the tree.

import { Router } from "express";
import type { Request } from "express";
import { z } from "zod";
import { requireRole } from "./util.js";
import { parseHomebox, homeboxMetadata, locationPathKey, type HomeboxItem, type HomeboxParse } from "../services/homebox.js";

export const homeboxRouter = Router({ mergeParams: true });

const INTERNAL_API = `http://127.0.0.1:${process.env.API_PORT ?? 4000}`;
const PART_CONCURRENCY = 6;

const Body = z.object({ csv: z.string().min(1).max(20 * 1024 * 1024) });

function bearer(req: Request): string {
  const a = req.headers.authorization;
  return typeof a === "string" && a.startsWith("Bearer ") ? a.slice(7) : "";
}
function slugOf(req: Request): string {
  return String((req.params as { slug?: string }).slug ?? "");
}

async function api<T = unknown>(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(`${INTERNAL_API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as T;
  return { status: res.status, json };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!, i);
      }
    }),
  );
  return out;
}

/** Preview payload: what WILL happen, plus a mapped sample + any warnings. */
function summarize(p: HomeboxParse) {
  return {
    is_homebox: p.detected.is_homebox,
    delimiter: p.detected.delimiter,
    item_count: p.items.length,
    location_count: p.location_paths.length,
    label_count: p.labels.length,
    custom_fields: p.custom_field_names,
    columns: p.detected.columns,
    warnings: p.warnings.slice(0, 50),
    errors: p.errors,
    sample: p.items.slice(0, 5).map((it) => ({
      name: it.name,
      quantity: it.quantity,
      location: it.location_path ? it.location_path.join(" / ") : null,
      labels: it.labels,
      manufacturer: it.manufacturer,
      serial_number: it.serial_number,
      cost: it.purchase_price,
    })),
  };
}

homeboxRouter.post("/homebox/preview", (req, res, next) => {
  void (async () => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "bad_body", message: "expected { csv }", details: parsed.error.issues } });
      return;
    }
    res.json(summarize(parseHomebox(parsed.data.csv)));
  })().catch(next);
});

/** Build (or reuse) the location tree; returns a pathKey→id map + created count. */
async function ensureLocations(slug: string, token: string, paths: string[][]): Promise<{ map: Map<string, string>; created: number; failed: number }> {
  const map = new Map<string, string>();
  // Seed from existing locations so an already-present tree is reused, not cloned.
  const existing = await api<{ items: Array<{ id: string; name: string; parent_id: string | null }> }>("GET", `/api/v1/orgs/${slug}/modules/core-locations/locations?limit=5000`, token);
  const byId = new Map<string, { name: string; parent_id: string | null }>();
  for (const l of existing.json?.items ?? []) byId.set(l.id, { name: l.name, parent_id: l.parent_id });
  const pathOf = (id: string): string[] => {
    const segs: string[] = [];
    let cur: string | null = id;
    const guard = new Set<string>();
    while (cur && byId.has(cur) && !guard.has(cur)) {
      guard.add(cur);
      const node: { name: string; parent_id: string | null } = byId.get(cur)!;
      segs.unshift(node.name);
      cur = node.parent_id;
    }
    return segs;
  };
  for (const [id] of byId) map.set(locationPathKey(pathOf(id)), id);

  let created = 0;
  let failed = 0;
  // paths arrive shallowest-first, so a parent is always created before its child.
  for (const segs of paths) {
    const key = locationPathKey(segs);
    if (map.has(key)) continue;
    const parentId = segs.length > 1 ? map.get(locationPathKey(segs.slice(0, -1))) ?? null : null;
    const r = await api<{ id: string }>("POST", `/api/v1/orgs/${slug}/modules/core-locations/locations`, token, {
      name: segs[segs.length - 1],
      parent_id: parentId,
    });
    if (r.status < 300 && r.json?.id) { map.set(key, r.json.id); created++; }
    else failed++;
  }
  return { map, created, failed };
}

homeboxRouter.post("/homebox", (req, res, next) => {
  void (async () => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "bad_body", message: "expected { csv }", details: parsed.error.issues } });
      return;
    }
    const slug = slugOf(req);
    const token = bearer(req);
    const p = parseHomebox(parsed.data.csv);
    if (p.errors.length) {
      res.status(400).json({ error: { code: "unparseable", message: p.errors[0]!.message }, errors: p.errors });
      return;
    }
    if (p.items.length === 0) {
      res.status(400).json({ error: { code: "empty", message: "no items found to import" } });
      return;
    }

    // Pre-flight: Inventory must be enabled (we import INTO it). Locations is
    // needed only if the export carries any; tags only if it carries labels.
    const mods = await api<{ items?: Array<{ name: string; enabled: boolean }>; modules?: Array<{ name: string; enabled: boolean }> }>("GET", `/api/v1/orgs/${slug}/modules`, token);
    const modList = mods.json?.items ?? mods.json?.modules ?? [];
    const enabled = (name: string) => modList.some((m) => m.name === name && m.enabled);
    if (modList.length && !enabled("inventory")) {
      res.status(400).json({ error: { code: "inventory_disabled", message: "Enable the Inventory module first — that's where imported items land." } });
      return;
    }
    const doLocations = p.location_paths.length > 0 && (!modList.length || enabled("core-locations"));

    // 1. Locations tree (create/reuse) → pathKey → id.
    const loc = doLocations
      ? await ensureLocations(slug, token, p.location_paths)
      : { map: new Map<string, string>(), created: 0, failed: 0 };

    // 2. Items → inventory parts.
    const errors: { row: number; message: string }[] = [];
    const results = await mapLimit(p.items, PART_CONCURRENCY, async (it: HomeboxItem) => {
      const locationId = it.location_path ? loc.map.get(locationPathKey(it.location_path)) ?? null : null;
      const meta = homeboxMetadata(it);
      const r = await api<{ id: string }>("POST", `/api/v1/orgs/${slug}/modules/inventory/parts`, token, {
        name: it.name,
        description: it.description,
        qty: it.quantity,
        unit: "each",
        cost: it.purchase_price ?? undefined,
        manufacturer: it.manufacturer,
        notes: it.notes,
        location_id: locationId,
        serial_number: it.serial_number,
        model_number: it.model_number,
        warranty_expires: it.warranty_expires,
        lifetime_warranty: it.lifetime_warranty,
        warranty_details: it.warranty_details,
        insured: it.insured,
        archived: it.archived,
        ...(meta ? { metadata: { homebox: meta } } : {}),
      });
      if (r.status >= 300 || !r.json?.id) {
        errors.push({ row: it.row, message: `part create failed (HTTP ${r.status})` });
        return null;
      }
      // 3. Labels → tags (attach-by-name; core-tags creates the tag).
      for (const label of it.labels) {
        await api("POST", `/api/v1/orgs/${slug}/modules/core-tags/attachments`, token, {
          tag_name: label,
          source_module: "inventory",
          source_type: "part",
          source_id: r.json.id,
        }).catch(() => undefined);
      }
      return r.json.id;
    });

    const createdIds = results.filter((x): x is string => typeof x === "string");
    res.json({
      items_imported: createdIds.length,
      items_failed: p.items.length - createdIds.length,
      locations_created: loc.created,
      labels_seen: p.labels.length,
      created_ids: createdIds,
      errors: [...p.warnings, ...errors].slice(0, 100),
    });
  })().catch(next);
});
