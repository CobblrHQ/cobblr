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

/** The one name every surface shows: the person's when there is one,
 *  untouched; the model's otherwise, read through the presentation rules
 *  (the first letter capitalised, a titled work's variants in the person's
 *  format). Reads a served row and a stored row alike. The stored value is
 *  never rewritten: display only, reversible, no migration (#3060). */
export function displayName(row: NamedRowLike, opts: { titleFormat?: TitleFormat | null } = {}): string | null {
  const person = personNameOf(row.suggested_metadata);
  if (person) return person;
  // A title's variants are composed by whoever knows the person's format:
  // the server, serving the row (a null preference is the default). A
  // caller that passes no format reads the row as served, so a surface never
  // re-formats a title the server composed in the person's format.
  if ("titleFormat" in opts) {
    const variants = formatTitleVariants(titleVariantsOf(row.suggested_metadata), opts.titleFormat);
    if (variants) return variants;
  }
  const column = clean(row.suggested_name);
  return column ? presentName(column) : null;
}

/** The name to WRITE when a row is filed without one given: the person's
 *  when there is one, else the stored column as the source spelt it. Never
 *  the presentation (`displayName`): the first-letter rule and a title's
 *  format are display only, so a filed record carries what was stored, and
 *  a barcode correction compares the source's spelling to the person's,
 *  not to a capital the display added (#3060). */
export function filingName(row: NamedRowLike): string | null {
  return personNameOf(row.suggested_metadata) ?? clean(row.suggested_name) ?? null;
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

// ── How a name READS (#3059 Engine 2: #3060, #3061, #3077). One formatter,
// three rules, read by every surface; the stored value is never rewritten.

/** The first letter of an ordinary name, capitalised at display: "corn
 *  Starch" reads "Corn Starch" (#3060). Only the first letter, only when
 *  the first word is plain lowercase letters: "iPhone", "eBay", "m&m's",
 *  "3D printer", "WD40" and an all-caps acronym keep their case, since a
 *  word with any capital, digit or symbol of its own is spelt that way on
 *  purpose. No Title Case: the owner did not ask for it and flagged it as
 *  possibly wrong. A name a PERSON typed is never touched (displayName
 *  handles that: person-provenance wins, as with every field). */
export function presentName(name: string): string {
  const s = name.trim();
  if (!s) return s;
  const first = s.split(/\s+/)[0] ?? "";
  if (!/^\p{Ll}+$/u.test(first)) return s;
  return s[0]!.toLocaleUpperCase() + s.slice(1);
}

/** A titled work's title, kept as SEPARATE values: what is printed on it
 *  in its own language, a translation of that, and a transliteration of
 *  it. A value the source did not give is absent, never made up: a literal
 *  translation and the published title of a translated edition are two
 *  different things, and neither is invented to fill a format (#3061). */
export interface TitleVariants {
  original?: { title: string; language?: string | null } | null;
  translation?: { title: string; language?: string | null } | null;
  transliteration?: { title: string } | null;
}

/** Where a row keeps its title variants (suggested_metadata). */
export const TITLE_VARIANTS_KEY = "title_variants";

/** How a person wants a title with variants to read. A PERSONAL preference
 *  (the account's), not a policy: the default leads with the original and
 *  brackets the translation, "Желтый туман (Yellow Fog)". */
export type TitleFormat =
  | "original"
  | "original-translation"
  | "translation-original"
  | "transliteration-translation"
  | "original-transliteration"
  | "translation";
export const TITLE_FORMATS: readonly TitleFormat[] = [
  "original-translation",
  "translation-original",
  "original",
  "translation",
  "original-transliteration",
  "transliteration-translation",
];
export const DEFAULT_TITLE_FORMAT: TitleFormat = "original-translation";

export const TITLE_FORMAT_LABELS: Record<TitleFormat, string> = {
  "original-translation": "Original (translation)",
  "translation-original": "Translation (original)",
  original: "Original only",
  translation: "Translation only",
  "original-transliteration": "Original (transliteration)",
  "transliteration-translation": "Transliteration (translation)",
};

export function asTitleFormat(v: unknown): TitleFormat | null {
  return typeof v === "string" && (TITLE_FORMATS as string[]).includes(v) ? (v as TitleFormat) : null;
}

export function titleVariantsOf(meta: unknown): TitleVariants | null {
  const v = ((meta ?? {}) as Record<string, unknown>)[TITLE_VARIANTS_KEY];
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const part = (k: string): { title: string; language?: string | null } | null => {
    const p = o[k];
    if (!p || typeof p !== "object") return null;
    const t = clean((p as { title?: unknown }).title);
    if (!t) return null;
    const lang = clean((p as { language?: unknown }).language);
    return lang ? { title: t, language: lang } : { title: t };
  };
  const out: TitleVariants = {};
  const original = part("original");
  const translation = part("translation");
  const transliteration = part("transliteration");
  if (original) out.original = original;
  if (translation) out.translation = translation;
  if (transliteration) out.transliteration = { title: transliteration.title };
  return original || translation || transliteration ? out : null;
}

/** The title in the person's format, from the variants the row HAS. A
 *  format asks for two values; with one missing, what exists is shown
 *  alone rather than a value invented for the slot. Null when there is no
 *  variant at all (the plain name stands). */
export function formatTitleVariants(v: TitleVariants | null | undefined, format: TitleFormat | null | undefined = DEFAULT_TITLE_FORMAT): string | null {
  if (!v) return null;
  const o = v.original?.title ?? null;
  const t = v.translation?.title ?? null;
  const r = v.transliteration?.title ?? null;
  const pair = (lead: string | null, bracket: string | null, alt: string | null): string | null => {
    if (lead && bracket && bracket !== lead) return `${lead} (${bracket})`;
    return lead ?? bracket ?? alt;
  };
  switch (format ?? DEFAULT_TITLE_FORMAT) {
    case "original":
      return o ?? t ?? r;
    case "translation":
      return t ?? o ?? r;
    case "translation-original":
      return pair(t, o, r);
    case "original-transliteration":
      return pair(o, r, t);
    case "transliteration-translation":
      return pair(r, t, o);
    case "original-translation":
    default:
      return pair(o, t, r);
  }
}

/** A field as a card lists it. */
export interface CardField {
  name: string;
  label?: string | null;
  value: unknown;
}

/** A field's label as a person reads it: the declared label, else the name
 *  with its underscores and prefixes spelt out ("set_number" reads "Set
 *  number", "isbn" reads "ISBN"). */
export function humanFieldLabel(name: string, label?: string | null): string {
  const l = clean(label);
  if (l) return l;
  const words = name.replace(/^x_/, "").split(/[_\s]+/).filter(Boolean);
  const upper = new Set(["isbn", "upc", "ean", "sku", "vin", "id", "url", "qr", "gtin", "asin", "mpn"]);
  return words
    .map((w, i) => (upper.has(w.toLowerCase()) ? w.toUpperCase() : i === 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function containsWhole(line: string, value: string): boolean {
  const i = line.indexOf(value);
  if (i === -1) return false;
  const before = i === 0 ? "" : line[i - 1]!;
  const after = i + value.length >= line.length ? "" : line[i + value.length]!;
  const wordy = (c: string) => /[\p{L}\p{N}]/u.test(c);
  return !wordy(before) && !wordy(after);
}

/** The fields a compact card shows: never the same value twice on one card
 *  (an ISBN in the title line and again as a field; a brand in the name and
 *  again as Brand), every label human-readable, every field the full detail
 *  keeps (this is a read for the compact card, not a cut of the record;
 *  #3077). `shown` is what the card already prints (the title line, the
 *  identity line), so a field whose value is in it is left out. */
export function compactCardFields(fields: readonly CardField[], shown: readonly (string | null | undefined)[]): Array<{ name: string; label: string; value: string }> {
  const seen = new Set<string>();
  const norm = (v: unknown): string => String(v ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  for (const s of shown) if (s) seen.add(norm(s));
  const printed = shown.filter((s): s is string => !!s).map((s) => s.toLowerCase());
  const out: Array<{ name: string; label: string; value: string }> = [];
  for (const f of fields) {
    if (f.value == null || f.value === "") continue;
    const value = String(f.value).replace(/\s+/g, " ").trim();
    const key = norm(value);
    if (!key || seen.has(key)) continue;
    // A value the card already prints inside a longer line (the ISBN inside
    // "ISBN 9785170058907", the brand inside the name) is already shown:
    // whole, between word breaks, so "558" is not found inside an ISBN.
    if (printed.some((p) => containsWhole(p, key))) continue;
    seen.add(key);
    out.push({ name: f.name, label: humanFieldLabel(f.name, f.label), value });
  }
  return out;
}
