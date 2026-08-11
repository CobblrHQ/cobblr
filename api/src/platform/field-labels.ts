// One place that turns stored ids into names, for FLAT rows.
//
// The generic entity resolver already post-processes what it returns (computed
// → relation → member). A module's own list route runs a SECOND, independent
// query over the same table and post-processes nothing, so the same record
// reads differently depending on which URL you asked. That is how a `relation`
// field has been printing raw uuids in module tables since it shipped, and how
// `member` did the same the day it landed: the bug is not the missing label, it
// is the second read path.
//
// Collapsing the two queries is the real fix and is a separate change. This is
// the seam that makes it possible: one helper, applied at both call sites, so
// there is a single definition of "what a resolved row looks like" to collapse
// onto — and `lint:list-route-labels` fails a module list route that skips it.
//
// Batched across the whole page on purpose: a 200-row list must cost one lookup
// per referenced KIND, not one per row.

import { meta } from "../db/meta.js";
import { lookupMany } from "./entities.js";
import { memberNamesFor } from "./member-fields.js";

interface LabelDef {
  name: string;
  type: string;
  ref_kind: string | null;
}

const TTL_MS = 5_000;
const defsCache = new Map<string, { at: number; defs: LabelDef[] }>();

export function clearFieldLabelDefsCache(): void {
  defsCache.clear();
}

async function labelDefsFor(orgId: string, kind: string): Promise<LabelDef[]> {
  const key = `${orgId}:${kind}`;
  const hit = defsCache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.defs;
  let defs: LabelDef[] = [];
  try {
    defs = await meta
      .selectFrom("module_field_defs")
      .select(["name", "type", "ref_kind"])
      .where("org_id", "=", orgId)
      .where("entity_kind", "=", kind)
      .where("type", "in", ["relation", "member"])
      .execute();
  } catch {
    defs = []; // a label is never worth failing a read over
  }
  defsCache.set(key, { at: Date.now(), defs });
  return defs;
}

function valueOf(row: Record<string, unknown>, name: string): string | null {
  const md = row.metadata;
  const fromMeta = md && typeof md === "object" ? (md as Record<string, unknown>)[name] : undefined;
  const v = fromMeta ?? row[name];
  return typeof v === "string" && v.trim() ? v : null;
}

/**
 * Inject `<name>_label` for every relation/member field on these rows.
 *
 * A no-op for kinds with no such fields, so a module route can call it
 * unconditionally without paying for it.
 */
export async function withFieldLabels<T extends Record<string, unknown>>(
  orgId: string,
  kind: string,
  rows: T[],
): Promise<T[]> {
  if (rows.length === 0) return rows;
  const defs = await labelDefsFor(orgId, kind);
  if (defs.length === 0) return rows;

  const memberDefs = defs.filter((d) => d.type === "member");
  const relationDefs = defs.filter((d) => d.type === "relation" && d.ref_kind);

  const names = memberDefs.length > 0 ? await memberNamesFor(orgId) : new Map<string, string>();

  // One lookupMany per referenced kind, across every row on the page.
  const titles = new Map<string, string>();
  if (relationDefs.length > 0) {
    const refs: Array<{ kind: string; id: string }> = [];
    for (const row of rows) {
      for (const d of relationDefs) {
        const v = valueOf(row, d.name);
        if (v) refs.push({ kind: d.ref_kind!, id: v });
      }
    }
    if (refs.length > 0) {
      const seen = new Set<string>();
      const unique = refs.filter((r) => {
        const k = `${r.kind}:${r.id}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      for (const t of await lookupMany(orgId, unique)) titles.set(`${t.kind}:${t.id}`, t.title);
    }
  }

  return rows.map((row) => {
    const labels: Record<string, unknown> = {};
    for (const d of memberDefs) {
      const v = valueOf(row, d.name);
      // Someone who has LEFT still reads as assigned to a person rather than
      // going blank, which would make the record look unclaimed.
      if (v) labels[`${d.name}_label`] = names.get(v) ?? "Former member";
    }
    for (const d of relationDefs) {
      const v = valueOf(row, d.name);
      if (v) labels[`${d.name}_label`] = titles.get(`${d.ref_kind}:${v}`) ?? null;
    }
    return Object.keys(labels).length > 0 ? { ...row, ...labels } : row;
  });
}
