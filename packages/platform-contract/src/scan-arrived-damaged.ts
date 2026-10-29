// An item that came in a delivery damaged (#8854). Two people unpacked a
// box with two damaged things in it; the only mark the card had was Broken,
// which opened a repair entry on the stock already on the shelf, and the
// delivered one was never recorded. Arrived damaged settles the scan without
// adding it to stock and keeps who said so, when, and what was wrong, on the
// row the owner reads in Recently committed.
//
// Buildless subpath: no runtime import of a sibling.

export const ARRIVED_DAMAGED_KEY = "arrived_damaged";

/** The button, on every surface that offers it. */
export const ARRIVED_DAMAGED_LABEL = "Arrived damaged";

export interface ScanArrivedDamaged {
  by: string | null;
  by_name: string;
  at: string;
  note: string | null;
  /** The thing it matched, when it matched one by its code. */
  record: { kind: string; id: string; title: string | null } | null;
}

export function scanArrivedDamaged(meta: unknown): ScanArrivedDamaged | null {
  const v = ((meta ?? {}) as Record<string, unknown>)[ARRIVED_DAMAGED_KEY] as Partial<ScanArrivedDamaged> | undefined;
  if (!v || typeof v !== "object" || typeof v.at !== "string") return null;
  return {
    by: typeof v.by === "string" ? v.by : null,
    by_name: typeof v.by_name === "string" && v.by_name ? v.by_name : "Someone",
    at: v.at,
    note: typeof v.note === "string" && v.note.trim() ? v.note.trim() : null,
    record: v.record && typeof v.record === "object" && typeof v.record.id === "string" ? v.record : null,
  };
}

/** The line Recently committed shows for it. */
export function arrivedDamagedLine(d: ScanArrivedDamaged): string {
  return `Arrived damaged, not added to stock · ${d.by_name}${d.note ? ` · ${d.note}` : ""}`;
}
