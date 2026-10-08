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
// "What a resolved row looks like" includes how a titled work's title READS
// for the person asking (#3061): the generic pipeline composes `title` from
// the record's forms for the request's actor (served-title.ts), and a module
// row that came through here carries the same `title` beside its stored
// `name`. The name is never touched: nothing composed is ever writable.
//
// Batched across the whole page on purpose: a 200-row list must cost one lookup
// per referenced KIND, not one per row.

import { resolveFieldDefsForKind } from "./field-defs.js";
import { lookupMany } from "./entities.js";
import { memberNamesFor } from "./member-fields.js";
import { personNamesFor } from "./people.js";
import { withServedTitle } from "./served-title.js";
import { ttlCache } from "../lib/ttl-cache.js";

interface LabelDef {
  name: string;
  type: string;
  ref_kind: string | null;
}

const TTL_MS = 5_000;
const defsCache = ttlCache<LabelDef[]>(TTL_MS);

export function clearFieldLabelDefsCache(): void {
  defsCache.clear();
}

async function labelDefsFor(orgId: string, kind: string): Promise<LabelDef[]> {
  const key = `${orgId}:${kind}`;
  return defsCache.get(key, async () => {
    let defs: LabelDef[] = [];
    try {
      // Through the one resolver, so a field scoped to this kind by its traits
      // is named too, not only one keyed to the kind.
      defs = (await resolveFieldDefsForKind(orgId, kind))
        .filter((d) => d.type === "relation" || d.type === "member" || d.type === "person")
        .map((d) => ({ name: d.name, type: d.type, ref_kind: d.ref_kind ?? null }));
    } catch {
      defs = []; // a label is never worth failing a read over
    }
    return defs;
  });
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
  const titled = rows.map(withServedTitle) as T[];
  const defs = await labelDefsFor(orgId, kind);
  if (defs.length === 0) return titled;

  const memberDefs = defs.filter((d) => d.type === "member");
  const personDefs = defs.filter((d) => d.type === "person");
  const people = personDefs.length > 0 ? await personNamesFor(orgId) : new Map<string, string>();
  const relationDefs = defs.filter((d) => d.type === "relation" && d.ref_kind);

  const names = memberDefs.length > 0 ? await memberNamesFor(orgId) : new Map<string, string>();

  // One lookupMany per referenced kind, across every row on the page.
  const titles = new Map<string, string>();
  if (relationDefs.length > 0) {
    const refs: Array<{ kind: string; id: string }> = [];
    for (const row of titled) {
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

  return titled.map((row) => {
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
    for (const d of personDefs) {
      const v = valueOf(row, d.name);
      if (v) labels[`${d.name}_label`] = people.get(v) ?? "Someone no longer listed";
    }
    return Object.keys(labels).length > 0 ? { ...row, ...labels } : row;
  });
}
