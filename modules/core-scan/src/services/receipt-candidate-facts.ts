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
// Matched by the ROLE the table declared when it declared one, and by field
// NAME across the words people use otherwise, because the provenance preset
// ships `acquired_from` and `acquired_on` while a workspace may have written
// `bought_from` or `store` by hand (acquisition-source.ts decides which field
// is which). Only fields the candidate's own table declares are touched;
// nothing is invented on a table that did not ask.
//
// Every value written here is EVIDENCE, and says so: the stamp it returns
// (field name → provenance) is what keeps a re-run from putting a guess back,
// and what keeps this pass off a value a person typed (#3008). A model's
// answer this pass displaced is kept on the stamp as `replaced`, so the
// contradiction is on the record rather than gone.

import type { ScanMenuEntry } from "./matchmaker.js";
// The names live in the platform contract because the card in the browser
// hides the same chips again when the session header already states them,
// and the field the server fills must be the field the card recognises.
import {
  RECEIPT_WEIGHT_NAMES as WEIGHT_NAMES,
  RECEIPT_WEIGHT_UNIT_NAMES as WEIGHT_UNIT_NAMES,
  RECEIPT_UNIT_PRICE_NAMES as UNIT_PRICE_NAMES,
} from "@cobblr/platform-contract/receipt-fact-names";
import {
  fieldProvenanceOf,
  isAcquiredFromField,
  isAcquiredOnField,
  isSellerField,
  mayWriteField,
  purchaseFieldRole,
  type FieldProvenanceMap,
} from "@cobblr/platform-contract/acquisition-source";

export interface ReceiptFactsMeta {
  source?: unknown;
  receipt_vendor?: unknown;
  receipt_seller?: unknown;
  receipt_date?: unknown;
  weight?: unknown;
  weight_unit?: unknown;
  unit_price?: unknown;
  field_provenance?: unknown;
}

interface CandidateLike {
  kind?: string;
  instance?: string | null;
  module?: string;
  fields?: Record<string, unknown>;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The menu entry a candidate routes to: the table (module + instance) first,
 *  since two instances of one module share a kind and the fields are the
 *  table's; by kind when no table matches. */
function entryFor(cand: CandidateLike, menu: readonly ScanMenuEntry[]): ScanMenuEntry | undefined {
  return (
    menu.find((e) => e.module === cand.module && (e.instance ?? null) === (cand.instance ?? null)) ??
    menu.find((e) => e.kind === cand.kind)
  );
}

/**
 * Write the receipt's own facts onto every candidate's fields, where the
 * candidate's table has somewhere to put them. Mutates in place, like the
 * decoder fill beside it. A no-op for anything that is not a receipt line.
 * Returns the provenance stamp for every field it wrote.
 */
export function applyReceiptFacts(
  meta: ReceiptFactsMeta | null | undefined,
  candidates: CandidateLike[],
  menu: readonly ScanMenuEntry[],
): FieldProvenanceMap {
  const stamps: FieldProvenanceMap = {};
  if (!meta || meta.source !== "receipt") return stamps;
  const vendor = str(meta.receipt_vendor);
  const seller = str(meta.receipt_seller);
  const date = str(meta.receipt_date);
  const weight = num(meta.weight);
  const weightUnit = str(meta.weight_unit);
  const unitPrice = num(meta.unit_price);
  const prior = fieldProvenanceOf(meta);

  for (const cand of candidates) {
    const entry = entryFor(cand, menu);
    if (!entry) continue;
    const fields = (cand.fields ??= {});
    // The receipt's facts OVERWRITE a model value: this is the one place the
    // model is not the better source, and "Facebook Marketplace" on a Lidl
    // receipt is what leaving its answer standing looks like. Never a value
    // a person put there: their answer outranks the paper.
    const write = (f: { name: string; field_role?: string | null }, value: string | number) => {
      const was = fields[f.name];
      if (!mayWriteField(prior[f.name], "evidence", { hasEvidence: true, hasValue: was !== undefined && was !== null && was !== "" })) return;
      fields[f.name] = value;
      const role = purchaseFieldRole(f);
      const displaced = was !== undefined && was !== null && String(was).trim() !== "" && String(was).trim() !== String(value).trim() ? String(was) : null;
      stamps[f.name] = { by: "evidence", from: "receipt", ...(role ? { role } : {}), ...(displaced ? { replaced: displaced } : {}) };
    };
    for (const f of entry.fields) {
      const name = f.name.toLowerCase();
      if (date && isAcquiredOnField(f)) write(f, date);
      else if (vendor && isAcquiredFromField(f)) write(f, vendor);
      // The seller only when the receipt names one apart from the shop; a
      // marketplace order has both, and they are different facts.
      else if (seller && seller !== vendor && isSellerField(f)) write(f, seller);
      else if (weight !== null && WEIGHT_NAMES.test(name) && f.type === "number") write(f, weight);
      else if (weightUnit && WEIGHT_UNIT_NAMES.test(name)) write(f, weightUnit);
      else if (unitPrice !== null && weight !== null && UNIT_PRICE_NAMES.test(name) && f.type === "number") {
        write(f, unitPrice);
      }
    }
  }
  return stamps;
}
