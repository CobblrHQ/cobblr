// Fitting a list of names into one short line.
//
// The dashboard tiles joined their names with " · " and let CSS `truncate` cut
// the overflow, which produced:
//
//   MACHINES  59
//   Machines · 3D Printers · Las...
//
// "Las..." is worse than nothing: it takes the space of a fact while telling you
// neither what the third thing is nor how many more there are. A count is short,
// honest, and the same width whatever the names happen to be.

export interface TileSummary {
  /** The names to print, in order. */
  shown: string[];
  /** How many were left out. Zero when everything fits. */
  extra: number;
}

/**
 * Keep the first `max` names and count the rest.
 *
 * Blank entries are dropped rather than printed as gaps, and they do not count
 * towards the overflow either - "+1 more" that turns out to be an empty string
 * is a lie about there being something else to see.
 */
export function summariseParts(parts: readonly string[], max = 2): TileSummary {
  const clean = parts.map((p) => p.trim()).filter(Boolean);
  if (clean.length <= max) return { shown: clean, extra: 0 };
  return { shown: clean.slice(0, max), extra: clean.length - max };
}

/** The line to print: "Machines · 3D Printers +2". */
export function summaryLine(parts: readonly string[], max = 2): string {
  const { shown, extra } = summariseParts(parts, max);
  if (shown.length === 0) return "";
  return extra > 0 ? `${shown.join(" · ")} +${extra}` : shown.join(" · ");
}
