// One storage story per card.
//
// A groceries table declares BOTH "Must be kept" (frozen / refrigerated /
// ambient, a property of the product) and "Storage" (Fridge / Freezer /
// Pantry / Counter, where this one lives). The model fills whichever it feels
// like, so a receipt's carrots wore "Fridge" + "Must be kept refrigerated"
// while its tomatoes wore "Storage Counter" and nothing else (2026-09-07).
// Same axis, two chips, three spellings.
//
// The two facts stay separate on the record (the storage check needs the
// requirement, the organiser needs the place). What gets ALIGNED is the fill:
//   - a cold requirement with no storage chosen picks the table's own cold
//     choice (refrigerated -> Fridge, frozen -> Freezer), so the card shows
//     "Storage Fridge" the way it shows "Storage Counter";
//   - a cold storage choice with no requirement stated asserts the one it
//     implies, so the storage check has something to check.
// Ambient is never filled from either side: pantry or counter is the person's
// call, and a counter proves nothing about the product.
//
// Then the card drops the requirement chip when the storage chip already says
// it (scanCandidateFields.isImpliedByPeer, same vocabulary), and keeps both
// when they disagree, because that is the one case where the pair is news.

import type { ScanMenuEntry } from "./matchmaker.js";
import { resolveRequirement } from "./storage-requirement.js";
import { choiceSatisfying, requirementImpliedByPlace } from "@cobblr/platform-contract/storage-requirement";

const REQUIREMENT_FIELD = /^storage_requirement$/;
const STORAGE_FIELD = /^storage$/;

interface CandidateLike {
  kind?: string;
  instance?: string | null;
  module?: string;
  category?: string;
  fields?: Record<string, unknown>;
}

function entryFor(cand: CandidateLike, menu: readonly ScanMenuEntry[]): ScanMenuEntry | undefined {
  return (
    menu.find((e) => e.kind === cand.kind) ??
    menu.find((e) => e.module === cand.module && (e.instance ?? null) === (cand.instance ?? null))
  );
}

const blank = (v: unknown): boolean => v === undefined || v === null || (typeof v === "string" && !v.trim());

/** Mutates in place, like the fills beside it. EMPTY-ONLY on both sides: a
 *  value the model or the person set is never overwritten, only a gap is
 *  filled from the other fact. Pure apart from the mutation; exported for
 *  the test. */
export function alignStorageFields(candidates: CandidateLike[], menu: readonly ScanMenuEntry[]): void {
  for (const cand of candidates) {
    const entry = entryFor(cand, menu);
    if (!entry) continue;
    const reqField = entry.fields.find((f) => REQUIREMENT_FIELD.test(f.name.toLowerCase()));
    const storeField = entry.fields.find((f) => STORAGE_FIELD.test(f.name.toLowerCase()));
    if (!reqField || !storeField) continue;
    const fields = (cand.fields ??= {});
    const storage = fields[storeField.name];
    const stated = fields[reqField.name];
    if (blank(storage)) {
      const req = resolveRequirement(stated, cand.category);
      const choice = choiceSatisfying(req, storeField.choices);
      if (choice) fields[storeField.name] = choice;
    } else if (blank(stated)) {
      const implied = requirementImpliedByPlace(typeof storage === "string" ? storage : null);
      if (implied) fields[reqField.name] = implied;
    }
  }
}
