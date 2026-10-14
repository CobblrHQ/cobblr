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

/** One part as the inbox holds it, for alikeParts: where it goes and the
 *  values it would be filed with. */
export interface AlikePartIn {
  id: string;
  name: string | null;
  quantity: number;
  destination: { module: string; instance: string | null; label?: string | null } | null;
  fields: Record<string, unknown> | null | undefined;
}

export interface AlikeField {
  key: string;
  label: string;
  value: string;
}

/** The parts of one split that are all the same kind of thing (#6456). */
export interface AlikeParts {
  destination: { module: string; instance: string | null; label: string | null };
  /** The values every part has, said once on the parent. */
  shared: AlikeField[];
  parts: Array<{ id: string; short: string; differs: AlikeField[]; quantity: number }>;
}

const shown = (v: unknown): string | null => {
  if (v === null || v === undefined || typeof v === "object") return null;
  const s = String(v).trim();
  return s ? s : null;
};
const same = (a: string | null, b: string | null) => (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

/** What the parts' names share at the front, cut at a word, so each part is
 *  called by what is its own: "KINGROON PETG Filament 1.75mm - US / yellow"
 *  beside its siblings is "yellow". */
export function sharedNamePrefix(names: readonly string[]): string {
  if (names.length < 2) return "";
  let p = names[0]!;
  for (const n of names.slice(1)) {
    let i = 0;
    while (i < p.length && i < n.length && p[i]!.toLowerCase() === n[i]!.toLowerCase()) i++;
    p = p.slice(0, i);
  }
  // Back to the last separator, so a shared first letter ("gray"/"green")
  // is never cut off a word.
  const cut = p.search(/[\s/,·|-][^\s/,·|-]*$/);
  return cut >= 0 ? p.slice(0, cut + 1) : "";
}

/**
 * When every part of a split is the same kind of thing (one destination),
 * what is said once on the parent and what each part says on its own row.
 * Computed from the values: a field every part has with one value is
 * shared; any other is what differs, on the parts that have it. A split of
 * different kinds, or one whose parts have no destination yet, is null and
 * keeps its full rows.
 */
export function alikeParts(parts: readonly AlikePartIn[], labels: Readonly<Record<string, string>> = {}): AlikeParts | null {
  if (parts.length < 2) return null;
  const d0 = parts[0]!.destination;
  if (!d0 || !parts.every((p) => p.destination && p.destination.module === d0.module && (p.destination.instance ?? null) === (d0.instance ?? null))) return null;
  const keys = [...new Set(parts.flatMap((p) => Object.keys(p.fields ?? {})))];
  const labelOf = (k: string) => labels[k] ?? k.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  const sharedKeys = new Set(
    keys.filter((k) => {
      const first = shown(parts[0]!.fields?.[k]);
      return first !== null && parts.every((p) => same(shown(p.fields?.[k]), first));
    }),
  );
  const shared = keys.filter((k) => sharedKeys.has(k)).map((k) => ({ key: k, label: labelOf(k), value: shown(parts[0]!.fields?.[k])! }));
  let prefix = sharedNamePrefix(parts.map((p) => p.name ?? ""));
  // A bare number is no name ("16" of "M3 x 16"), nor is one that starts
  // mid-phrase ("x 16"): the words before it stay.
  const ownOf = (name: string) => name.slice(prefix.length).replace(/^[\s/,·|-]+/, "").trim();
  const bare = (own: string) => /^[\d.,]*$/.test(own) || (own.split(/[\s/,·|-]+/)[0] ?? "").length < 2;
  while (prefix && parts.some((p) => bare(ownOf(p.name ?? "")))) {
    const cut = prefix.replace(/[\s/,·|-]+$/, "").search(/[\s/,·|-][^\s/,·|-]*$/);
    prefix = cut >= 0 ? prefix.slice(0, cut + 1) : "";
  }
  return {
    destination: { module: d0.module, instance: d0.instance ?? null, label: d0.label ?? null },
    shared,
    parts: parts.map((p) => {
      const name = p.name ?? "";
      const own = ownOf(name);
      const short = own || name;
      return {
        id: p.id,
        short,
        // A value the short name already says ("yellow") is not said twice.
        differs: keys
          .filter((k) => !sharedKeys.has(k))
          .flatMap((k) => {
            const v = shown(p.fields?.[k]);
            return v === null || short.toLowerCase().includes(v.toLowerCase()) ? [] : [{ key: k, label: labelOf(k), value: v }];
          }),
        quantity: p.quantity,
      };
    }),
  };
}

/** A product name without the copy number a store gives a second variant of
 *  the same name: Shopify titles a duplicate "Multicolor-1", and the owner's
 *  pack was named "… / 10KG / Multicolor-1" beside its twin (#6527). Only a
 *  single digit after a word of letters ending the last variant segment, so
 *  "M3-10", "Pack-12" and a name with no variant keep theirs. The line as
 *  the store wrote it is kept apart (its `description`), for finding the
 *  variant on the store's page. */
export function withoutStoreCopySuffix(name: string): string {
  return name.replace(/^(.* \/ [^/]*?[A-Za-z]{3})-[1-9]$/, "$1");
}

/** A part's own words in one case on the screen (#6527: "light apricot",
 *  "Purple", "grass green" side by side). Each word that starts with a
 *  lower-case letter gets a capital; a stored value is never rewritten, and
 *  a word with a digit ("1.75mm") or a single letter ("x") is left alone. */
export function titleWords(s: string): string {
  return s.replace(/(^|[\s/(-])([a-z])([a-z']+)(?=$|[\s/),-])/g, (_m, pre: string, first: string, rest: string) => `${pre}${first.toUpperCase()}${rest}`);
}
