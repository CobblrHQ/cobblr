// A line split into its parts, said the one way every surface says it
// (#6067). The owner, on his Kingroon session: "The problem is that the UI
// does not show how one line item was expanded into its contents." The pack
// line stays visible as the parent, its parts sit under it, and the parent
// says how the split was decided and whether the parts add up.
//
// Pure: the parent's stored note and marks in, the words out. The server
// builds a summary per parent (core-scan services/split-groups.ts) and the
// inbox draws it; the assistant reads the same summary.

/** How a line came apart. Stamped as `split_how` by every split since #6067;
 *  an older row's is read from the note its split wrote. */
export type SplitHow = "known" | "network" | "store" | "labels" | "hand" | "photo" | "off";

export const SPLIT_HOW_WORDS: Record<SplitHow, string> = {
  known: "From what this pack is known to hold",
  network: "From what people confirmed on the barcode network",
  store: "From the store's product page",
  labels: "Read from the box labels",
  hand: "Split by hand",
  photo: "From the photo, one part per thing in it",
  off: "Split off by hand",
};

const HOWS = new Set<string>(Object.keys(SPLIT_HOW_WORDS));

/** How the parent was split, or null when it does not say. */
export function splitHowOf(parent: { ai_notes?: string | null; suggested_metadata?: unknown }): SplitHow | null {
  const m = (parent.suggested_metadata ?? {}) as { split_how?: unknown; line_units?: { by?: unknown } | null; split_off_into?: unknown };
  if (typeof m.split_how === "string" && HOWS.has(m.split_how)) return m.split_how as SplitHow;
  const note = parent.ai_notes ?? "";
  if (/from what this pack is known to hold/i.test(note)) return "known";
  if (/barcode network/i.test(note)) return "network";
  if (/from the store's page/i.test(note)) return "store";
  if (/box labels?/i.test(note)) return "labels";
  if (/by hand/i.test(note) || m.line_units?.by === "person") return "hand";
  if (/^Split into \d+ items?\.$/i.test(note.trim())) return "photo";
  if (Array.isArray(m.split_off_into) && m.split_off_into.length) return "off";
  return null;
}

/** The parts against what the line said it held: "10 of 10", or "8 of 10,
 *  2 colour unknown" when a part's colour could not be read. `units` counts
 *  every part's units, filed or not. */
export function splitCheckSentence(c: { units: number; of: number | null; unknown: number }): string {
  const of = c.of && c.of > 0 ? c.of : c.units;
  const known = c.units - c.unknown;
  if (c.unknown > 0) return `${known} of ${of}, ${c.unknown} colour unknown`;
  return `${c.units} of ${of}`;
}

/** The parent's line: "A pack of 10, split into 9 rows" (two spools of one
 *  colour share a row). */
export function splitHeadline(c: { units: number; rows: number; pack: boolean }): string {
  const what = c.pack ? `A pack of ${c.units}` : `${c.units} things`;
  return c.rows === c.units ? `${what}, split into ${c.rows}` : `${what}, split into ${c.rows} rows`;
}

/** What the inbox shows for one split line. */
export interface SplitParentSummary {
  id: string;
  name: string | null;
  quantity: number;
  line_total: number | null;
  currency: string | null;
  how: SplitHow | null;
  how_words: string | null;
  headline: string;
  check: string;
  /** Every part, filed or not, in the order the split made them. */
  parts: string[];
  /** Parts already filed: the line can no longer be put back. */
  filed: number;
  /** Whether Undo split can put the line back (nothing filed yet). */
  can_undo: boolean;
  /** A pending line whose parts were split off it (Split off): the line is
   *  in the inbox too, and stays the parent. */
  pending: boolean;
}

/** The parent a part answers to: a split's, or a split-off's line. */
export function splitParentIdOf(meta: unknown): string | null {
  const m = (meta ?? {}) as { split_from?: unknown; split_off_from?: unknown };
  if (typeof m.split_from === "string" && m.split_from) return m.split_from;
  if (typeof m.split_off_from === "string" && m.split_off_from) return m.split_off_from;
  return null;
}
