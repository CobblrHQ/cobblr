// Scan-to-set + nesting decision logic (pure, unit-tested).
//
// Scanning a location's QR sets the active filing "bin". The nesting rule is
// active-bin aware and kind-aware so it never mis-nests:
//   • scan a CONTAINER while a bin is active → it files INTO the active bin
//     (reparent it there) and becomes the new bin — "scan the room, then scan the
//     tote: the tote is now in the room, and you're filing into the tote".
//   • scan an AREA → it's a context switch (a different room/zone); just adopt it
//     as the bin, never reparent — so scanning two rooms in a row doesn't nest
//     one inside the other.
// Reparenting that would create a cycle (the scanned location is an ancestor of
// the active bin — e.g. scanning the room again from inside it) is skipped; we
// just switch context. The core-locations PATCH rejects cycles too, as a backstop.

export interface FilingLoc {
  id: string;
  name: string;
  short_name?: string | null;
  parent_id: string | null;
  kind: "area" | "container";
}

export interface LocationScanDecision {
  /** The location id to make the active filing bin. */
  bin: string;
  /** When set, reparent `child` under `parent` first (nesting). */
  reparent: { child: string; parent: string } | null;
}

/** Would making `candidate` the parent of nothing… i.e. is `candidate` already an
 *  ancestor of `node`? (Reparenting `candidate` under `node` would then cycle.) */
function isAncestorOf(candidate: string, node: string, byId: Map<string, FilingLoc>): boolean {
  let cursor: string | null = node;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const cur = byId.get(cursor);
    if (!cur) break;
    if (cur.parent_id === candidate) return true;
    cursor = cur.parent_id;
  }
  return false;
}

export function decideLocationScan(
  scannedId: string,
  activeBinId: string | null,
  byId: Map<string, FilingLoc>,
): LocationScanDecision {
  const scanned = byId.get(scannedId);
  // Unknown location, no active bin, or re-scanning the current bin → just adopt.
  if (!scanned || !activeBinId || activeBinId === scannedId) {
    return { bin: scannedId, reparent: null };
  }
  // A container files into the active bin (nest) — unless it's already there, or
  // it's an ancestor of the active bin (would cycle).
  if (
    scanned.kind === "container" &&
    scanned.parent_id !== activeBinId &&
    !isAncestorOf(scannedId, activeBinId, byId)
  ) {
    return { bin: scannedId, reparent: { child: scannedId, parent: activeBinId } };
  }
  // An area (context switch) or an already-nested / would-cycle container → adopt.
  return { bin: scannedId, reparent: null };
}

/** A short display label for a filing location. */
export function filingLabel(loc: Pick<FilingLoc, "name" | "short_name">): string {
  return loc.short_name || loc.name;
}
