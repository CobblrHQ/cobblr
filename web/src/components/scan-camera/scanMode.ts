// The scan camera's mode: one setting with four values (#6438). It is kept as
// three remembered flags (Move, Count, Sort), and Add is all three off.

export type ScanMode = "add" | "move" | "count" | "sort";

export interface ScanModeFlags {
  moveMode: boolean;
  countMode: boolean;
  sortMode: boolean;
}

/** The mode the flags hold. Count wins over Sort over Move, the same order a
 *  scan reads them in. */
export function scanModeOf(f: ScanModeFlags): ScanMode {
  return f.countMode ? "count" : f.sortMode ? "sort" : f.moveMode ? "move" : "add";
}

/** What a scan files as in this mode. */
export function scanPurposeOf(f: ScanModeFlags): "count" | "sort" | "move" | "arrival" {
  const m = scanModeOf(f);
  return m === "add" ? "arrival" : m;
}

/** The flags that choosing `mode` leaves: exactly that one on, or none for Add. */
export function flagsFor(mode: ScanMode): ScanModeFlags {
  return { moveMode: mode === "move", countMode: mode === "count", sortMode: mode === "sort" };
}

export const SCAN_MODES: ReadonlyArray<{ mode: ScanMode; label: string; line: string }> = [
  { mode: "add", label: "Add", line: "A new thing goes to the scan inbox; one you have opens its record." },
  { mode: "move", label: "Move", line: "A thing you have moves to the current area at once." },
  { mode: "count", label: "Count", line: "A thing you have asks how many are on the shelf. For a whole collection, use Recount all… on its list." },
  { mode: "sort", label: "Sort", line: "Each scan tells you which bin it goes in." },
];

export const scanModeLabel = (mode: ScanMode): string => SCAN_MODES.find((m) => m.mode === mode)!.label;
