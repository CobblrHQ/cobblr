// Applying a chosen category value, without asking where it lives.
//
// The seam (platform().categoryAxis) answers what to write; this puts it in
// the right bag. Kept beside the contract rather than in the api so every
// caller applies it the same way: a module that reads the slot itself is a
// second implementation of the thing #3223 exists to have only one of.

import type { CategoryAxisAssignment, CategoryAxisSlot } from "./index.js";
import { normaliseCategory } from "@cobblr/platform-contract/category-reconcile";

export interface AxisTarget {
  /** Custom-field values on the record (the confirm's `fields`). */
  fields: Record<string, unknown>;
  /** Columns on the record itself (the confirm's top-level body). */
  row: Record<string, unknown>;
}

/** Put `assignment` where its slot says. A null assignment writes nothing,
 *  which is the "could not store it, file the thing anyway" case. */
export function applyAxisValue(assignment: CategoryAxisAssignment | null, into: AxisTarget): void {
  if (!assignment) return;
  if (assignment.slot.kind === "extras") into.fields[assignment.slot.name] = assignment.value;
  else into.row[assignment.slot.column] = assignment.value;
}

/** Empty the axis's slot on a record: what a caller does when the value
 *  there cannot stand (an id the seam's `keep` found in no store), so the
 *  record is written without it rather than refused over it. */
export function clearAxisValue(axis: { slot: CategoryAxisSlot } | null | undefined, from: AxisTarget): void {
  if (!axis) return;
  if (axis.slot.kind === "extras") delete from.fields[axis.slot.name];
  else delete from.row[axis.slot.column];
}

/** The value a caller already holds for this axis, wherever it keeps it.
 *
 *  The mirror of applyAxisValue, and here for the same reason: the scan
 *  confirm has to find the category the person chose BEFORE it can commit it,
 *  and the only way to find it without this is to read the slot — which is the
 *  second implementation the seam exists to remove. A choice-backed axis keeps
 *  it under the field's key; a native-backed one keeps the record id on the
 *  row. Returns "" when there is nothing there, which a caller treats as
 *  "nothing to commit". */
export function readAxisValue(axis: { slot: CategoryAxisSlot } | null | undefined, from: AxisTarget): string {
  if (!axis) return "";
  const raw = axis.slot.kind === "extras" ? from.fields[axis.slot.name] : from.row[axis.slot.column];
  return typeof raw === "string" ? raw.trim() : "";
}

/** The values a native taxonomy offers, deduplicated by normalised key.
 *
 *  EVERY node is a candidate, parents included, so a scan that says
 *  "Groceries" snaps onto the parent rather than coining a sibling of it.
 *  When two branches normalise to the same key the shallower one wins, and a
 *  tie at one depth goes to the spelling that sorts first with capitals ahead
 *  of lowercase ("Yarn" over "yarn"), which is both deterministic and the
 *  better label to show. `find`-first would otherwise pick by insertion order,
 *  and two callers a second apart could rank against different spellings of
 *  one key. */
export function dedupeByKey(rows: Array<{ id: string; name: string; parentId?: string | null }>): Array<{ id: string; name: string }> {
  const byKey = new Map<string, { id: string; name: string; depth: number }>();
  const depthOf = (r: { id: string; parentId?: string | null }, seen = new Set<string>()): number => {
    let d = 0;
    let cur = r;
    while (cur.parentId && !seen.has(cur.id)) {
      seen.add(cur.id);
      const parent = rows.find((x) => x.id === cur.parentId);
      if (!parent) break;
      cur = parent;
      d += 1;
    }
    return d;
  };
  for (const r of rows) {
    const key = normaliseCategory(r.name);
    if (!key) continue;
    const depth = depthOf(r);
    const held = byKey.get(key);
    if (!held || depth < held.depth || (depth === held.depth && compareNames(r.name, held.name) < 0)) {
      byKey.set(key, { id: r.id, name: r.name, depth });
    }
  }
  return [...byKey.values()].map((v) => ({ id: v.id, name: v.name })).sort((a, b) => compareNames(a.name, b.name));
}

/** Alphabetical, capitals first. One comparator for the pick and the order, so
 *  the value chosen for a key is also where it appears in the list. */
function compareNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { caseFirst: "upper" });
}

/** A field def as this rule needs to see it. */
export interface AxisDefLike {
  id: string;
  name: string;
  field_role?: string | null;
  display_label?: string | null;
  choices?: string[] | null;
}

/** Which store answers for a kind, and never which one it intends to use.
 *
 *  A kind may declare a native taxonomy AND still carry the placeholder choice
 *  field: the declaration ships before the reconcile that stops creating the
 *  def. Preferring the declaration in that window is the #3223 symptom wearing
 *  the seam's clothes — the menu offers taxonomy names while the card writes
 *  text into the def, and nothing reaches the taxonomy. So a def present means
 *  def-backed, whatever the manifest says, and the flip is one observable
 *  change on the day the def goes.
 *
 *  Returns null when the kind has neither. */
export function chooseAxisBacking(
  defs: readonly AxisDefLike[],
  nativeKind: string | null,
):
  | { kind: "extras"; label: string; values: string[]; slot: { kind: "extras"; name: string; defId: string } }
  | { kind: "native"; entityKind: string }
  | null {
  const def = defs.find((d) => d.field_role === "category");
  if (def) {
    const seen = new Map<string, string>();
    for (const c of def.choices ?? []) {
      const key = normaliseCategory(c);
      if (key && !seen.has(key)) seen.set(key, c);
    }
    return {
      kind: "extras",
      label: def.display_label ?? def.name,
      values: [...seen.values()],
      slot: { kind: "extras", name: def.name, defId: def.id },
    };
  }
  return nativeKind ? { kind: "native", entityKind: nativeKind } : null;
}
