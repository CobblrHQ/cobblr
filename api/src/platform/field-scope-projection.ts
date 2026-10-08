// A field scoped to a capability is never shown to someone without it, on any
// route (the field-scopes rule, PermissionsPage and /field-scopes).
//
// The scope held only where records went through the entity projection
// (entities.ts applyExposableProjection): the entity API. Every module route
// that returns its own rows (GET /instances/inventory/items, a module's list,
// a view's data) answered the raw row, metadata included, so a member without
// "costs" read secret_cost from the very pages the product shows them.
//
// So this is applied by the kernel to every response a module mount (and the
// collection-items mount) sends, not asked of each module: for a viewer who
// holds some capabilities but not all, every field gated in this workspace
// that they lack is taken out of every record in the answer, wherever it
// sits (a record's own key, its `metadata`, a resolved entity's `fields`). It
// is keyed by field name, not kind: a view's data carries another module's
// records, and a field name gated on one kind and not on another is taken
// out of both, the safe side of a rare collision.

import type { NextFunction, Request, Response } from "express";
import { roleHoldsEveryCapability } from "@cobblr/platform-contract/org-roles";
import { csvCellAsWritten } from "@cobblr/platform-contract/csv";
import { meta } from "../db/meta.js";
import { effectiveCapabilities } from "../auth/effective-capabilities.js";

let manifestScopes: Array<{ field: string; capability: string }> | null = null;

/** The field scopes every kind's manifest declares (registered at boot). */
async function declaredFieldScopes(): Promise<Array<{ field: string; capability: string }>> {
  if (manifestScopes) return manifestScopes;
  const rows = await meta.selectFrom("entity_kinds").select(["field_read_scopes"]).where("field_read_scopes", "is not", null).execute();
  const out: Array<{ field: string; capability: string }> = [];
  for (const r of rows) {
    for (const [field, capability] of Object.entries((r.field_read_scopes as Record<string, string> | null) ?? {})) out.push({ field, capability });
  }
  manifestScopes = out;
  return out;
}

/** The field names this viewer may not read in this workspace; empty when
 *  nothing gated is out of their reach. */
export async function hiddenFieldsFor(orgId: string, userId: string, role: string): Promise<Set<string>> {
  if (roleHoldsEveryCapability(role)) return new Set();
  const perOrg = await meta.selectFrom("workspace_field_scopes").select(["field", "capability"]).where("org_id", "=", orgId).execute();
  const gated = [...(await declaredFieldScopes()), ...perOrg];
  if (gated.length === 0) return new Set();
  const held = await effectiveCapabilities(orgId, userId, role);
  if (held.all) return new Set();
  return new Set(gated.filter((g) => !held.caps.has(g.capability)).map((g) => g.field));
}

const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date) && !Buffer.isBuffer(v);

/** Take the hidden fields out of every record-shaped object in a response. */
export function withoutHiddenFields(body: unknown, hidden: ReadonlySet<string>, depth = 0): unknown {
  if (depth > 12 || hidden.size === 0) return body;
  if (Array.isArray(body)) return body.map((x) => withoutHiddenFields(x, hidden, depth + 1));
  if (!plain(body)) return body;
  const out: Record<string, unknown> = {};
  const isRecord = "id" in body;
  for (const [k, v] of Object.entries(body)) {
    if (isRecord && hidden.has(k)) continue;
    if ((k === "metadata" || k === "fields" || k === "custom_fields") && plain(v)) {
      out[k] = Object.fromEntries(Object.entries(v).filter(([f]) => !hidden.has(f)));
      continue;
    }
    out[k] = withoutHiddenFields(v, hidden, depth + 1);
  }
  return out;
}

/** RFC 4180 rows: quoted cells may hold commas, quotes and line breaks. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const BOM = "\uFEFF";

/** A CSV answer without the columns headed by a hidden field. Every other
 *  cell goes back exactly as the exporter wrote it, byte order mark and line
 *  ends included. */
export function csvWithoutHiddenColumns(text: string, hidden: ReadonlySet<string>): string {
  const bom = text.startsWith(BOM);
  const rows = parseCsv(bom ? text.slice(1) : text);
  const header = rows[0];
  if (!header) return text;
  const keep = header.map((h, i) => (hidden.has(h.trim()) ? -1 : i)).filter((i) => i >= 0);
  if (keep.length === header.length) return text;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  return (bom ? BOM : "") + rows.map((r) => keep.map((i) => csvCellAsWritten(r[i] ?? "")).join(",")).join(eol) + eol;
}

/** Express middleware, after withTenant: every JSON answer from here on is
 *  projected for this viewer, and so is a CSV export (by its column names). */
export async function projectFieldScopes(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const t = req.tenant;
    const userId = req.session?.id;
    if (!t || !userId) return next();
    const hidden = await hiddenFieldsFor(t.org.id, userId, t.role);
    const json = res.json.bind(res);
    res.json = ((body: unknown) => json(withoutHiddenFields(body, hidden))) as typeof res.json;
    if (hidden.size > 0) {
      const send = res.send.bind(res);
      res.send = ((body: unknown) => {
        const type = String(res.getHeader("Content-Type") ?? "");
        if (/text\/csv/i.test(type) && (typeof body === "string" || Buffer.isBuffer(body))) {
          return send(csvWithoutHiddenColumns(Buffer.isBuffer(body) ? body.toString("utf8") : body, hidden));
        }
        return send(body);
      }) as typeof res.send;
    }
    next();
  } catch (err) {
    next(err);
  }
}
