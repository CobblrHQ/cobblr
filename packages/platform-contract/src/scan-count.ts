// A scan that matched something you already have changes its count: by what
// is in your hands (Change by), or to what is actually there (Set total).
//
// One rule for the card that shows it and the route that writes it, so the
// words on the card and the line in the ledger cannot say different things.
//
// Change by is a change, never the total: it starts at +1, because a scan
// usually means "I have another", and below zero it TAKES ("I scanned the
// empty box, one is used up"). The person never does arithmetic: the card
// shows "You have 3 → 4". Set total is the recount, a different mode with a
// different colour, and the ledger files it as a correction, so a shelf that
// held two fewer than the record said is never read as two eaten.

export type ScanCountMode = "change" | "set";

/** Why, for the ledger line. Optional: a chip, never a question. */
export const SCAN_COUNT_REASONS = ["replaced", "still_had", "used_up", "went_bad", "tossed"] as const;
export type ScanCountReason = (typeof SCAN_COUNT_REASONS)[number];

/** The reasons that make sense for a change of this sign, in what the
 *  collection wears. Stock (things used up and bought again): adding means the
 *  one it replaces ran out, or there was still some; taking means used up,
 *  or thrown out. Waste only where the thing can go off. A thing that is KEPT
 *  (a second copy of a book) has no reasons to give: "replaced the one that
 *  ran out" under The Hobbit is the wrong collection's words. */
export function scanCountReasonsFor(change: number, opts: { stock: boolean; perishable: boolean }): ScanCountReason[] {
  if (!opts.stock) return [];
  if (change > 0) return ["replaced", "still_had"];
  if (change < 0) return opts.perishable ? ["used_up", "went_bad", "tossed"] : ["used_up", "tossed"];
  return [];
}

export const SCAN_COUNT_REASON_LABEL: Record<ScanCountReason, string> = {
  replaced: "Replaced one that ran out",
  still_had: "Still had some",
  used_up: "Used it up",
  went_bad: "Went bad",
  tossed: "Threw it out",
};

/** The ledger line's words. */
export function scanCountLedgerReason(move: { change: number; correction: boolean; reason?: ScanCountReason | null }): string {
  if (move.correction) return "recounted from a scan";
  switch (move.reason) {
    case "replaced":
      return "replaced the one that ran out (scan)";
    case "still_had":
      return "more of the same (scan)";
    case "used_up":
      return "used up (scan)";
    case "went_bad":
      return "went bad (scan)";
    case "tossed":
      return "thrown out (scan)";
    default:
      return move.change > 0 ? "restocked from a scan" : "taken from a scan";
  }
}

/** What the card says about the value in the stepper. */
export function scanCountLabel(mode: ScanCountMode, value: number): string {
  if (mode === "set") return "Recount";
  if (value > 0) return `Adding ${value}`;
  if (value < 0) return `Taking ${-value}`;
  return "Nothing";
}

/** The count the record will have. Taking never goes below zero: the floor
 *  takes what is there and the card says so. */
export function scanCountResult(mode: ScanCountMode, have: number, value: number): number {
  return mode === "set" ? Math.max(0, value) : Math.max(0, have + value);
}

/** Where a new card's stepper starts: +1 in Change by (the scan in your
 *  hand), the current count in Set total. */
export function scanCountStart(mode: ScanCountMode, have: number, scanned = 1): number {
  return mode === "set" ? Math.max(0, have) : Math.max(1, scanned);
}

/** The request body the card sends, and the only shape the route accepts:
 *  exactly one of a non-zero change or a total. */
export function scanCountBody(mode: ScanCountMode, value: number, reason?: ScanCountReason | null): { change: number; reason?: ScanCountReason } | { total: number } | null {
  if (mode === "set") return value >= 0 ? { total: value } : null;
  if (value === 0) return null;
  return { change: value, ...(reason ? { reason } : {}) };
}

/** Where "Add to shopping list" goes: the lists module's own add action,
 *  which finds (or makes) the list called "Shopping list" and dedupes a line
 *  already on it. Named once, here, beside the rule that decides when the card
 *  offers it; the card offers it only while that module is on. */
export const SHOPPING_LIST_DOOR = { module: "lists", action: "lists:add-item" } as const;

/** Whether a take left the record at its minimum or empty, which is when
 *  the card offers the shopping list. */
export function scanCountLeftLow(newQty: number | null, minQty: number | null | undefined, took: boolean): boolean {
  if (!took || newQty == null) return false;
  if (newQty <= 0) return true;
  return minQty != null && minQty > 0 && newQty <= minQty;
}
