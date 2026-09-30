// What a record counts as it is used, for "service it every 5,000 miles".
//
// Two sources, one answer. A module may declare counters its own code keeps
// (a machine's print hours, EntityWriter.counters). And any number field a
// workspace marks with the `usage` role ("Mileage", "Hours run") is a counter
// on its kind, with no code of the kind's own: before this, only machines
// could be serviced by use, so a car's oil change could only fall due by the
// calendar. Every reader of counters (the schedule form's choices, the
// schedule's due reading) asks here, so the two cannot disagree.

import type { EntityCounterDef } from "@cobblr/platform-contract";
import { getEntityWriterFor, lookup } from "./entities.js";
import { resolveFieldDefsForKind } from "./field-defs.js";

async function usageFields(orgId: string, kind: string): Promise<EntityCounterDef[]> {
  const defs = await resolveFieldDefsForKind(orgId, kind).catch(() => []);
  return defs
    .filter((d) => d.field_role === "usage" && d.type === "number")
    .map((d) => ({ key: d.name, label: d.display_label.toLowerCase() }));
}

/** The counters a kind keeps: the module's own first, then its usage fields. */
export async function countersFor(orgId: string, kind: string): Promise<EntityCounterDef[]> {
  const w = await getEntityWriterFor(orgId, kind).catch(() => null);
  const own = [...(w?.counters?.defs ?? [])];
  const seen = new Set(own.map((d) => d.key));
  return [...own, ...(await usageFields(orgId, kind)).filter((d) => !seen.has(d.key))];
}

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** One record's reading of every counter its kind keeps. */
export async function readCounters(orgId: string, kind: string, id: string): Promise<Record<string, number | null>> {
  const w = await getEntityWriterFor(orgId, kind).catch(() => null);
  const own = w?.counters ? await w.counters.read(orgId, id).catch(() => ({}) as Record<string, number | null>) : {};
  const fields = await usageFields(orgId, kind);
  if (fields.length === 0) return own;
  const rec = await lookup(orgId, kind, id).catch(() => null);
  const values = (rec?.fields ?? {}) as Record<string, unknown>;
  const meta = (values.metadata ?? {}) as Record<string, unknown>;
  const out: Record<string, number | null> = { ...own };
  for (const f of fields) if (!(f.key in out)) out[f.key] = num(meta[f.key] ?? values[f.key]);
  return out;
}
