// A receipt KNOWS where and when a thing was bought. The model only guesses.
//
// On a Lidl receipt, one line arrived as "Acquired from: Facebook Marketplace"
// (2026-09-06). The workspace's provenance field had exactly one choice, so
// the model picked the only option - a plausible-looking answer to a question
// it had no way to answer. Two other lines got "Bought on 2026-09-06" and ten
// got nothing, for the same reason: the model fills what it feels like.
//
// The till printed the shop and the date on every line. Those are facts, and
// they are written HERE, after the model, so they win:
//
//   a date field  the receipt's date
//   a "from" field  the receipt's vendor
//   a weight field  the printed weight, for a line sold by weight
//
// Matched by field NAME across the words people use, not by a role, because
// the provenance preset ships `acquired_from` and `acquired_on` while a
// workspace may have written `bought_from` or `store` by hand. Only fields the
// candidate's own table declares are touched; nothing is invented on a table
// that did not ask.

import type { ScanMenuEntry } from "./matchmaker.js";

const DATE_NAMES = /^(acquired|purchased|bought)_(on|at|date)$|^purchase_date$|^date_(acquired|purchased|bought)$/;
const FROM_NAMES = /^(acquired|purchased|bought|sourced)_from$|^(vendor|store|retailer|shop|supplier|source_store|purchased_at_store)$/;
const WEIGHT_NAMES = /^(net_)?weight$/;
const WEIGHT_UNIT_NAMES = /^weight_unit$/;
const UNIT_PRICE_NAMES = /^(unit_price|price_per_unit|price_per_lb|price_per_kg)$/;

export interface ReceiptFactsMeta {
  source?: unknown;
  receipt_vendor?: unknown;
  receipt_date?: unknown;
  weight?: unknown;
  weight_unit?: unknown;
  unit_price?: unknown;
}

interface CandidateLike {
  kind?: string;
  instance?: string | null;
  module?: string;
  fields?: Record<string, unknown>;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The menu entry a candidate routes to, by kind then by module + instance. */
function entryFor(cand: CandidateLike, menu: readonly ScanMenuEntry[]): ScanMenuEntry | undefined {
  return (
    menu.find((e) => e.kind === cand.kind) ??
    menu.find((e) => e.module === cand.module && (e.instance ?? null) === (cand.instance ?? null))
  );
}

/**
 * Write the receipt's own facts onto every candidate's fields, where the
 * candidate's table has somewhere to put them. Mutates in place, like the
 * decoder fill beside it. A no-op for anything that is not a receipt line.
 */
export function applyReceiptFacts(
  meta: ReceiptFactsMeta | null | undefined,
  candidates: CandidateLike[],
  menu: readonly ScanMenuEntry[],
): void {
  if (!meta || meta.source !== "receipt") return;
  const vendor = str(meta.receipt_vendor);
  const date = str(meta.receipt_date);
  const weight = num(meta.weight);
  const weightUnit = str(meta.weight_unit);
  const unitPrice = num(meta.unit_price);

  for (const cand of candidates) {
    const entry = entryFor(cand, menu);
    if (!entry) continue;
    const fields = (cand.fields ??= {});
    for (const f of entry.fields) {
      const name = f.name.toLowerCase();
      // The receipt's facts OVERWRITE a model value: this is the one place the
      // model is not the better source, and "Facebook Marketplace" on a Lidl
      // receipt is what leaving its answer standing looks like.
      if (date && DATE_NAMES.test(name)) fields[f.name] = date;
      else if (vendor && FROM_NAMES.test(name)) fields[f.name] = vendor;
      else if (weight !== null && WEIGHT_NAMES.test(name) && f.type === "number") fields[f.name] = weight;
      else if (weightUnit && WEIGHT_UNIT_NAMES.test(name)) fields[f.name] = weightUnit;
      else if (unitPrice !== null && weight !== null && UNIT_PRICE_NAMES.test(name) && f.type === "number") {
        fields[f.name] = unitPrice;
      }
    }
  }
}
