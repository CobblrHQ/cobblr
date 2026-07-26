// What a printer remembers about the stock loaded in it.
//
// The label size used to live in this browser's localStorage, so it did not follow
// you to another computer and each printer forgot the stock actually in it. The
// printer row already persists in the workspace, so the memory belongs there.
//
// Pure helpers, kept out of the React effect so the rules are testable: the write
// must not loop against the refetch it triggers, and a restore must not be mistaken
// for a user edit.

/** The size fields we stash on a printer's settings blob. */
export interface PrinterMemory {
  lastSizeKey?: string;
  lastPaperKey?: string;
  lastRotate?: boolean;
  lastUsedAt?: string;
}

/** What to restore when this printer becomes the active target. Returns only the
 *  fields actually remembered, so an unset one keeps the current selection rather
 *  than snapping it to a default. */
export function rememberedSelection(settings: Record<string, unknown> | undefined): {
  sizeKey?: string;
  paperKey?: string;
  rotate?: boolean;
} {
  const s = settings ?? {};
  const out: { sizeKey?: string; paperKey?: string; rotate?: boolean } = {};
  if (typeof s.lastSizeKey === "string" && s.lastSizeKey) out.sizeKey = s.lastSizeKey;
  if (typeof s.lastPaperKey === "string" && s.lastPaperKey) out.paperKey = s.lastPaperKey;
  if (typeof s.lastRotate === "boolean") out.rotate = s.lastRotate;
  return out;
}

/** True when the printer's memory differs from what is selected now.
 *
 *  This is the loop guard: saving triggers a printers refetch, which re-runs the
 *  effect with a NEW printer object. Without this equality check that would save
 *  again, forever. */
export function needsRemember(
  settings: Record<string, unknown> | undefined,
  sel: { sizeKey: string; paperKey: string; rotate: boolean },
): boolean {
  if (!sel.sizeKey) return false; // nothing meaningful to remember yet
  const s = settings ?? {};
  return s.lastSizeKey !== sel.sizeKey || s.lastPaperKey !== sel.paperKey || s.lastRotate !== sel.rotate;
}

/** Printers most-recently-used first — device history, so the target picker leads
 *  with the machine you actually print on. Never used sorts last, and ties fall
 *  back to name so the order is stable rather than arbitrary. */
export function byRecentlyUsed<T extends { name: string; settings?: Record<string, unknown> }>(printers: T[]): T[] {
  const at = (p: T) => {
    const v = (p.settings ?? {}).lastUsedAt;
    const t = typeof v === "string" ? Date.parse(v) : NaN;
    return Number.isNaN(t) ? -Infinity : t;
  };
  return [...printers].sort((a, b) => at(b) - at(a) || a.name.localeCompare(b.name));
}

/** Label sizes this workspace ACTUALLY prints, most-recently-used first.
 *
 *  Real media history. The old presetsForPrinter GUESSED at this by reading the
 *  media currently configured on other printers, which is why its "sizes you've
 *  used" chips could show sizes nobody had printed. Now that every print records
 *  lastSizeKey + lastUsedAt on the printer it went to, the history is simply read
 *  back instead of inferred.
 *
 *  Deduped by size key, keeping the most recent timestamp for each. */
export function recentSizeKeys(
  printers: readonly { settings?: Record<string, unknown> }[],
  limit = 4,
): string[] {
  const at = new Map<string, number>();
  for (const p of printers) {
    const s = p.settings ?? {};
    const key = typeof s.lastSizeKey === "string" ? s.lastSizeKey : "";
    if (!key) continue;
    const raw = s.lastUsedAt;
    const t = typeof raw === "string" ? Date.parse(raw) : NaN;
    const when = Number.isNaN(t) ? 0 : t;
    if (when >= (at.get(key) ?? -1)) at.set(key, when);
  }
  return [...at.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([k]) => k);
}
