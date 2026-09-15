// A concise display identity for a long marketing title, for the closed
// card: the thing a person scans a list for. The stored name is never
// rewritten; this is a READ of it, and the full name stays one hover or one
// Details away (#3009: "Cosori Double Wall Electric Kettle With Steel Outer
// Shell, Two-Level Lid, 304 Stainless Steel BPA Free..." on a card whose
// only job is to be recognised).
//
// Deterministic, by shape, no model call (code plans, the model narrates):
//   - the lead is the title up to the first marketing joiner (", " / " - " /
//     " (" / " with " / " | " / " compatible"), so brand + type survive;
//   - a SHORT trailing segment is a variant, not marketing (", Black" on
//     three shirts that differ only by colour), and stays in the lead;
//   - a model or variant token in the cut part (KS230, WH-1000XM6, D6733, a
//     capacity like 1.5L) is carried into the lead when the lead has none of
//     its own, since that token is the identity; the clause around it comes
//     along ("KS230 KIT V2"), capped short;
//   - a lead still longer than the budget is cut at a word boundary.

export interface DisplayIdentity {
  /** What the closed card shows. */
  lead: string;
  /** The part the lead leaves out, or null when the lead is the whole name. */
  rest: string | null;
}

const JOINERS = [", ", " - ", " – ", " — ", " (", " with ", " With ", " | ", " compatible", " Compatible"];
/** A model / variant / capacity token: letters and digits together (KS230,
 *  G16, WH-1000XM6, 1.5L, 32GB), or a letter-prefixed number (D6733). */
const TOKEN = /\b(?=[A-Za-z0-9.-]*\d)(?=[A-Za-z0-9.-]*[A-Za-z])[A-Za-z0-9][A-Za-z0-9.-]{1,}\b/g;
const VARIANT_MAX = 24;
const BUDGET = 72;
const CLAUSE_MAX = 18;

function firstJoiner(name: string): number {
  let at = -1;
  for (const j of JOINERS) {
    const i = name.indexOf(j);
    if (i > 0 && (at === -1 || i < at)) at = i;
  }
  return at;
}

function cutAtWord(s: string, max: number): string {
  if (s.length <= max) return s;
  const i = s.lastIndexOf(" ", max);
  return (i > max / 2 ? s.slice(0, i) : s.slice(0, max)).replace(/[\s,;:-]+$/, "");
}

/** The clause around the identifying token in `rest`: a letter-led token is
 *  a model (KS230, D6733, WH-1000XM6) and wins over a number-led spec
 *  (2.4GHz, 32GB); with no model, the first spec (a capacity, 1.5L) stands
 *  in. From the token to the next comma or paren, capped, so "KS230 KIT V2"
 *  comes whole. */
function tokenClause(rest: string): string | null {
  const all = [...rest.matchAll(TOKEN)];
  if (!all.length) return null;
  const model = all.find((m) => /^[A-Za-z]/.test(m[0]) && /\d/.test(m[0]));
  const pick = model ?? all[0]!;
  const from = pick.index!;
  const end = rest.slice(from).search(/[,()|]|\s-\s/);
  const clause = (end === -1 ? rest.slice(from) : rest.slice(from, from + end)).trim();
  return cutAtWord(clause, CLAUSE_MAX);
}

export function displayIdentity(name: string | null | undefined): DisplayIdentity {
  const full = (name ?? "").replace(/\s+/g, " ").trim();
  if (!full) return { lead: "", rest: null };
  const at = firstJoiner(full);
  let lead = full;
  let rest: string | null = null;
  if (at > 0) {
    const tail = full.slice(at).replace(/^[\s,|(–—-]+/, "").replace(/^(with|With|compatible|Compatible)\s+/, "").trim();
    // A short tail with no joiner of its own is a variant, and identity.
    if (tail.length <= VARIANT_MAX && firstJoiner(tail) === -1 && full.length <= BUDGET) {
      return { lead: full, rest: null };
    }
    lead = full.slice(0, at).trim();
    rest = tail;
  }
  if (lead.length > BUDGET) {
    const cut = cutAtWord(lead, BUDGET);
    rest = [lead.slice(cut.length).trim(), rest].filter(Boolean).join(", ") || null;
    lead = cut;
  }
  if (rest) {
    TOKEN.lastIndex = 0;
    const leadHasToken = TOKEN.test(lead);
    TOKEN.lastIndex = 0;
    if (!leadHasToken) {
      const clause = tokenClause(rest);
      if (clause && !lead.includes(clause)) lead = `${lead} · ${clause}`;
    }
  }
  return { lead, rest };
}

// ── One name, whoever wrote it (#2982) ────────────────────────────────────
//
// A row's name has two writers: the person (a rename on the card, the
// screen, the chip) and the model (a lookup, a re-run, the picture sweep).
// #3014 gave every other field a `person` stamp that no pass overwrites;
// the name is a field and gets the same. The person's name is kept on the
// row's metadata under USER_NAME_KEY and stamped `person` in
// field_provenance; the model keeps writing suggested_name as it always
// did, and every reader resolves through displayName() so the person's
// name is what shows, the model's newest read is offered beside it.

import { FIELD_PROVENANCE_KEY, type FieldProvenanceMap } from "@cobblr/platform-contract/acquisition-source";

/** Where a person's own name for a row lives on its metadata. */
export const USER_NAME_KEY = "user_name";

export interface NamedRowLike {
  suggested_name: string | null | undefined;
  suggested_metadata?: unknown;
}

const clean = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** The name a person gave this row, or null when only the model has spoken. */
export function personNameOf(meta: unknown): string | null {
  const m = (meta ?? {}) as Record<string, unknown>;
  return clean(m[USER_NAME_KEY]);
}

/** The one name every surface shows: the person's when there is one, the
 *  model's otherwise. Reads a served row and a stored row alike. */
export function displayName(row: NamedRowLike): string | null {
  return personNameOf(row.suggested_metadata) ?? clean(row.suggested_name);
}

/** The model's name when a person's stands and the model's newest read
 *  differs: what the card offers beside the title, never what it shows.
 *  On a stored row that is the column; on a served row (already resolved
 *  to the person's) it is the `replaced` the stamp carries. */
export function modelNameBeside(row: NamedRowLike): string | null {
  const person = personNameOf(row.suggested_metadata);
  if (!person) return null;
  const column = clean(row.suggested_name);
  if (column && column !== person) return column;
  const prov = ((row.suggested_metadata ?? {}) as Record<string, unknown>)[FIELD_PROVENANCE_KEY] as FieldProvenanceMap | undefined;
  const replaced = clean(prov?.name?.replaced);
  return replaced && replaced !== person ? replaced : null;
}
