// How many records a wire would fire on, now (the composer's dry run).
//
// A wire's conditions are judged per firing against the record's fields and
// an `event.*` block describing the change. A count of existing records has
// no change to judge, so each event condition is read as the STATE the change
// leads to: "ran out" (event.newQty <= 0 from above) is "the count is 0 now".
// What names the change itself (event.oldQty, event.delta) cannot be a state
// and is left out; any other event.* cannot be judged at all. Both are said
// back, so the number is never read as more than it is.

import { platform, type EntityViewer } from "@cobblr/platform-contract";
import type { WireRecords } from "@cobblr/platform-contract/wire-narrowing";
import { templateDataOf } from "@cobblr/platform-contract/entity-metadata";
import { meta } from "../db/meta.js";
import { baseKindOf } from "./entities.js";
import { parseWireFilter, passesWireFilter, type WireFilter } from "./wire-filter.js";
import { inWireRecords } from "./wire-records.js";

/** The field a stock change's new count is, on the record. */
const NEW_COUNT_FIELD = "qty";
/** Event keys that describe the change, not the record: no state to count. */
const CHANGE_ONLY = new Set(["event.oldQty", "event.delta"]);

export interface WirePreview {
  /** Records that fit right now; null when they could not be read. */
  count: number | null;
  /** Every record of the kind, for "12 of 40". */
  of: number | null;
  /** False when the kind has more records than were read (the count is a floor). */
  complete: boolean;
  /** What the number means for this trigger, the words after the count. */
  means: string;
  /** Conditions that could not be judged on an existing record. */
  ignored: string[];
}

/** The filter as a state of the record. Pure. */
export function filterAsState(filter: WireFilter | null): { filter: WireFilter | null; ignored: string[] } {
  if (!filter?.all) return { filter, ignored: [] };
  const ignored: string[] = [];
  const all = filter.all.flatMap((c) => {
    const path = c.path === "event.newQty" ? NEW_COUNT_FIELD : c.path;
    if (CHANGE_ONLY.has(c.path)) return [];
    if (path.startsWith("event.")) {
      ignored.push(path);
      return [];
    }
    return [{ ...c, path }];
  });
  return { filter: all.length || filter.in ? { ...(all.length ? { all } : {}), ...(filter.in ? { in: filter.in } : {}) } : null, ignored };
}

/** What the number means, by trigger, as the words after the count ("12
 *  parts <means>"). Pure. */
export function meansOf(trigger: string): string {
  switch (trigger) {
    case "event":
      return "in that state now; the wire fires as each one gets there, not on these";
    case "on-create":
      return "fit now; it fires on new ones as they are added, not on these";
    case "on-update":
      return "fit now; it fires when one of them changes";
    case "on-delete":
      return "fit now; it fires as one is removed";
    case "schedule":
      return "fit now; each time it runs it looks at the ones that fit then";
    default:
      return "fit now; a button works on the one record it is pressed on";
  }
}

const READ_CAP = 5000;

export async function previewWire(
  orgId: string,
  viewer: EntityViewer,
  input: { source_kind: string; trigger_type: string; filter?: unknown },
): Promise<WirePreview & { error?: string }> {
  const parsed = parseWireFilter(input.filter ?? null);
  if (parsed.error) return { count: null, of: null, complete: true, means: "", ignored: [], error: parsed.error };
  const { filter, ignored } = filterAsState(parsed.filter);
  const means = meansOf(input.trigger_type);
  const base = await baseKindOf(orgId, input.source_kind);
  const read = await platform().entities.listAll(orgId, input.source_kind, {}, viewer, { cap: READ_CAP });
  if (read.failed || read.unlisted) return { count: null, of: null, complete: true, means, ignored };
  let count = 0;
  for (const r of read.items) {
    const data = templateDataOf(r.fields ?? {});
    if (!passesWireFilter(filter, data)) continue;
    if (filter?.in && !(await inWireRecords(orgId, filter.in as WireRecords, { kind: base, id: r.id, fields: r.fields ?? {} }).catch(() => false))) continue;
    count++;
  }
  return { count, of: read.total ?? read.items.length, complete: read.complete, means, ignored };
}

export interface RelationshipInUse {
  relationship: string;
  count: number;
  /** Links leaving a record of the asked kind / arriving at one. */
  out: number;
  in: number;
}

/** The relationship kinds in use in the workspace, most used first. With a
 *  kind, only those that touch it, and which way. */
export async function relationshipsInUse(orgId: string, kind?: string): Promise<RelationshipInUse[]> {
  const rows = await meta
    .selectFrom("entity_pairings")
    .select(["relationship_kind", "source_kind", "target_kind"])
    .where("org_id", "=", orgId)
    .execute();
  const by = new Map<string, RelationshipInUse>();
  for (const r of rows) {
    const asOut = !kind || r.source_kind === kind;
    const asIn = !kind || r.target_kind === kind;
    if (!asOut && !asIn) continue;
    const row = by.get(r.relationship_kind) ?? { relationship: r.relationship_kind, count: 0, out: 0, in: 0 };
    row.count++;
    if (kind) {
      if (r.source_kind === kind) row.out++;
      if (r.target_kind === kind) row.in++;
    }
    by.set(r.relationship_kind, row);
  }
  return [...by.values()].sort((a, b) => b.count - a.count || a.relationship.localeCompare(b.relationship));
}
