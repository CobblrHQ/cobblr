// Which record a scan in a recount is (#6302). Pure: the recount engine
// (recount.ts) hands it the expected records and the ones already counted.
//
// Strongest first: a record the person picked, then a barcode, then what the
// label says. Records that agree on every attribute and name are one TYPE
// (ten white Kingroon PETG spools): they are interchangeable, so a scan of
// that type takes the next one not yet counted and never asks which. An
// attribute the scan states that a record contradicts (a red spool against a
// white one) rules that record out, however alike the names. Two types read
// equally well is a question, one choice per type. Nothing alike, or a type
// already counted in full, is something new.
import { normalizeColour } from "@cobblr/platform-contract/colour";
import { nameMatch } from "./stocktake-photo.js";
import type { StocktakeItem } from "./stocktake.js";

export interface RecountItem extends StocktakeItem {
  manufacturer: string | null;
  /** The record's own field values (material, colour, diameter...), as the
   *  collection's fields store them. */
  attributes: Record<string, string>;
  /** Where it is now, as a person reads it, or null when it has no place. */
  place: string | null;
}

export interface RecountScanInput {
  /** A record the person picked from the list. */
  record_id?: string | null;
  barcode?: string | null;
  /** What the label says (typed, or read off a photo). */
  text?: string | null;
  /** Attributes the label states: brand, material, colour, diameter... */
  attributes?: Record<string, unknown> | null;
  /** The record a scanned code names, when the code is not a barcode on
   *  record but a Cobblr label printed for it (resolved before matching). */
  coded_record_id?: string | null;
  /** The person said it is none of the things offered: something new. */
  new?: boolean | null;
}

export type RecountMatch =
  | { kind: "matched"; id: string; by: "picked" | "barcode" | "label" }
  | { kind: "ask"; candidates: RecountItem[] }
  /** `like`: a record of the type it reads as, when there is one (an extra
   *  white spool is added like the white ones). */
  | { kind: "new"; like: string | null }
  | { kind: "refused"; reason: string };

const norm = (v: unknown): string => String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const sameValue = (a: string, b: string): boolean => {
  const x = norm(a);
  const y = norm(b);
  if (x === y) return true;
  // One colour, two spellings: "#ffffff" on record, "White" on the label.
  const cx = normalizeColour(x);
  const cy = normalizeColour(y);
  if (cx && cy) return cx === cy;
  const nx = Number.parseFloat(x);
  const ny = Number.parseFloat(y);
  return Number.isFinite(nx) && Number.isFinite(ny) && /^[\d.]+\s*[a-z]*$/.test(x) && /^[\d.]+\s*[a-z]*$/.test(y) && nx === ny;
};
const digits = (code: unknown): string => String(code ?? "").replace(/\s+/g, "").trim();

/** A record's attributes as a scan names them: its fields, and its maker as "brand". */
function attributesOf(item: RecountItem): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(item.attributes)) if (norm(v)) out.set(norm(k), String(v));
  if (item.manufacturer?.trim()) out.set("brand", item.manufacturer);
  return out;
}

/** Records that read alike on every count are one type. */
export function typeKey(item: RecountItem): string {
  const attrs = [...attributesOf(item)].map(([k, v]) => `${k}=${norm(v)}`).sort();
  return `${norm(item.title)}|${attrs.join(";")}`;
}

export function matchScan(input: RecountScanInput, expected: readonly RecountItem[], seen: ReadonlySet<string>): RecountMatch {
  if (input.record_id) {
    const item = expected.find((e) => e.id === input.record_id);
    if (!item) return { kind: "refused", reason: "That is not one of the things in this recount." };
    if (seen.has(item.id)) return { kind: "refused", reason: `${item.title} is already counted in this recount.` };
    return { kind: "matched", id: item.id, by: "picked" };
  }

  if (input.new) return { kind: "new", like: null };
  if (input.coded_record_id) {
    const item = expected.find((e) => e.id === input.coded_record_id);
    if (item) return seen.has(item.id) ? { kind: "refused", reason: `${item.title} is already counted in this recount.` } : { kind: "matched", id: item.id, by: "barcode" };
  }
  const code = digits(input.barcode);
  const said = Object.entries(input.attributes ?? {}).filter(([, v]) => norm(v)).map(([k, v]) => [norm(k), String(v)] as const);
  const text = input.text?.trim() ?? "";
  if (code) {
    const holding = expected.filter((e) => e.barcode && digits(e.barcode) === code);
    if (holding.length) {
      const next = holding.find((e) => !seen.has(e.id));
      return next ? { kind: "matched", id: next.id, by: "barcode" } : { kind: "new", like: holding[0]!.id };
    }
    // A code nobody here holds says nothing about which record it is; the
    // label still might.
    if (!text && !said.length) return { kind: "new", like: null };
  }
  if (!text && !said.length) return { kind: "refused", reason: "Scan a code, say what the label reads, or pick the thing from the list." };

  // One entry per type, scored once: every record of a type reads the same.
  const types = new Map<string, RecountItem[]>();
  for (const e of expected) types.set(typeKey(e), [...(types.get(typeKey(e)) ?? []), e]);
  const scored: Array<{ records: RecountItem[]; score: number }> = [];
  for (const records of types.values()) {
    const rep = records[0]!;
    const attrs = attributesOf(rep);
    let agree = 0;
    let contradicts = false;
    for (const [k, v] of said) {
      const theirs = attrs.get(k);
      if (theirs === undefined) continue;
      if (sameValue(theirs, v)) agree++;
      else contradicts = true;
    }
    if (contradicts) continue;
    const name = text ? nameMatch(text, rep.title) : 0;
    if (name < 0.5 && agree < 2) continue;
    scored.push({ records, score: agree + name });
  }
  if (!scored.length) return { kind: "new", like: null };
  const best = Math.max(...scored.map((s) => s.score));
  const tied = scored.filter((s) => s.score >= best - 1e-6);
  const rep = (records: RecountItem[]) => records.find((r) => !seen.has(r.id)) ?? records[0]!;
  if (tied.length > 1) return { kind: "ask", candidates: tied.map((t) => rep(t.records)) };
  const next = tied[0]!.records.find((r) => !seen.has(r.id));
  return next ? { kind: "matched", id: next.id, by: "label" } : { kind: "new", like: tied[0]!.records[0]!.id };
}
