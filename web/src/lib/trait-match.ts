// Client-side mirror of the backend's trait matcher
// (api/src/platform/actions.ts matchAction). Used by the Actions
// config page to preview which entity kinds a trait predicate would
// match *before* the user saves the override — so toggling a
// checkbox shows its effect live.
//
// Keep this in sync with the backend matcher. The semantics:
// within an axis the predicate ORs (either pole matches), across
// axes it ANDs (every axis the predicate names must be satisfied).

import type { PlatformEntityKind } from "./api";

const AXIS_OF_TRAIT: Record<string, string> = {
  physical: "tangibility",
  digital: "tangibility",
  fungible: "identity",
  unique: "identity",
  container: "containment",
  containable: "containment",
  schedulable: "time",
  timeless: "time",
  completable: "lifecycle",
  indefinite: "lifecycle",
  durable: "persistence",
  ephemeral: "persistence",
};

/** Flatten an entity kind's trait map into a Set of trait values,
 *  unwrapping the `{ trait, uncertain }` shape. */
function collectTraitValues(
  traits: PlatformEntityKind["traits"],
): Set<string> {
  const out = new Set<string>();
  if (!traits) return out;
  for (const v of Object.values(traits)) {
    if (typeof v === "string") out.add(v);
    else if (v && typeof v === "object" && "trait" in v) out.add(v.trait);
  }
  return out;
}

/** True if the given trait predicate (a flat list of trait names)
 *  matches the entity kind. Empty predicate matches nothing. */
export function traitPredicateMatches(
  selectedTraits: string[],
  kind: PlatformEntityKind,
): boolean {
  if (selectedTraits.length === 0) return false;
  const have = collectTraitValues(kind.traits);
  const byAxis = new Map<string, string[]>();
  for (const t of selectedTraits) {
    const axis = AXIS_OF_TRAIT[t];
    if (!axis) continue;
    const list = byAxis.get(axis) ?? [];
    list.push(t);
    byAxis.set(axis, list);
  }
  if (byAxis.size === 0) return false;
  return [...byAxis.values()].every((traits) =>
    traits.some((t) => have.has(t)),
  );
}
