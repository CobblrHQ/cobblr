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
  /** True only when a PERSON worked the turn toggle. Without this, the
   *  auto-derived default is written back on the first save and then reads as
   *  the user's own choice forever, so the default can never adapt when the
   *  label size changes. */
  lastRotateExplicit?: boolean;
  /** The layout last chosen ON each media, keyed by paper.
   *
   *  A single lastSizeKey cannot express this: pick 50x30 2-up, switch to
   *  another media, switch back, and the 2-up is gone because the one
   *  remembered size is no longer valid for the paper you left and the picker
   *  falls to that paper's first entry. The choice of how to tile a roll
   *  belongs to the roll. */
  lastSizeByPaper?: Record<string, string>;
  lastUsedAt?: string;
}

/** What to restore when this printer becomes the active target. Returns only the
 *  fields actually remembered, so an unset one keeps the current selection rather
 *  than snapping it to a default. */
export function rememberedSelection(settings: Record<string, unknown> | undefined): {
  sizeKey?: string;
  paperKey?: string;
  rotate?: boolean;
  rotateExplicit?: boolean;
} {
  const s = settings ?? {};
  const out: { sizeKey?: string; paperKey?: string; rotate?: boolean; rotateExplicit?: boolean } = {};
  if (typeof s.lastSizeKey === "string" && s.lastSizeKey) out.sizeKey = s.lastSizeKey;
  if (typeof s.lastPaperKey === "string" && s.lastPaperKey) out.paperKey = s.lastPaperKey;
  // An auto-derived turn is NOT restored as a choice: the size may have changed
  // since, and the rule re-derives it. Only a real toggle is honoured.
  if (typeof s.lastRotate === "boolean" && s.lastRotateExplicit === true) {
    out.rotate = s.lastRotate;
    out.rotateExplicit = true;
  }
  return out;
}

/** The layout remembered for each media on this printer. */
export function sizeByPaper(settings: Record<string, unknown> | undefined): Record<string, string> {
  const v = (settings ?? {}).lastSizeByPaper;
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof k === "string" && typeof val === "string" && k && val) out[k] = val;
  }
  return out;
}

/** Fold one (paper, size) choice into the remembered map, or null when it would
 *  change nothing — the same loop guard the rest of this file uses, since every
 *  save triggers a printers refetch. */
export function withSizeForPaper(
  settings: Record<string, unknown> | undefined,
  paperKey: string,
  sizeKey: string,
): Record<string, string> | null {
  if (!paperKey || !sizeKey) return null;
  const cur = sizeByPaper(settings);
  if (cur[paperKey] === sizeKey) return null;
  return { ...cur, [paperKey]: sizeKey };
}

/** True when the printer's memory differs from what is selected now.
 *
 *  This is the loop guard: saving triggers a printers refetch, which re-runs the
 *  effect with a NEW printer object. Without this equality check that would save
 *  again, forever. */
export function needsRemember(
  settings: Record<string, unknown> | undefined,
  sel: { sizeKey: string; paperKey: string; rotate: boolean; rotateExplicit?: boolean },
): boolean {
  if (!sel.sizeKey) return false; // nothing meaningful to remember yet
  const s = settings ?? {};
  return (
    s.lastSizeKey !== sel.sizeKey ||
    s.lastPaperKey !== sel.paperKey ||
    s.lastRotate !== sel.rotate ||
    s.lastRotateExplicit !== (sel.rotateExplicit ?? false) ||
    withSizeForPaper(settings, sel.paperKey, sel.sizeKey) !== null
  );
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
