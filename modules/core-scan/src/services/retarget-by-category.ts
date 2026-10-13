// A candidate that lands in a module's catch-all table with a category that
// NAMES one of the module's own lists goes to that list instead.
//
// The model recognised green tea as tea and said so, as an inventory category
// called "Teas", on a candidate routed to the base Inventory table, in a
// workspace that has a Teas list (2026-09-08). Twelve items went that way:
// tea, spices, baking supplies, each filed in the catch-all with a category
// spelling out where it should have gone. The rule is the platform's
// (@cobblr/platform-contract/instance-for-category); here it is applied to
// the scan menu, where the sibling lists are the same module's non-default
// entries.

import type { ScanMenuEntry } from "./matchmaker.js";
import { instanceForCategory } from "@cobblr/platform-contract/instance-for-category";
import { codeKindOf } from "./barcode-lookup.js";

/** What a list's records ARE, read from how they are identified: a list
 *  whose records carry an ISBN holds books, whatever the list is called (a
 *  Bookshelf copied from another workspace kept its fields and lost its
 *  noun, #6155). Words the category rule matches beside the list's names. */
const HELD_BY_IDENTIFIER: Readonly<Record<string, string>> = { "identifier:isbn": "book" };
export function heldThings(entry: Pick<ScanMenuEntry, "fields">): string[] {
  // The decode role a bundle declares, or, where a copy carried the field
  // but not its decode role (a field made through the field API keeps only
  // its meaning), an identifier field by that identifier's name.
  const roleOf = (f: ScanMenuEntry["fields"][number]) => f.decode_role ?? (f.field_role === "identifier" ? `identifier:${f.name.toLowerCase()}` : null);
  return [...new Set(entry.fields.flatMap((f) => { const r = roleOf(f); return r && HELD_BY_IDENTIFIER[r] ? [HELD_BY_IDENTIFIER[r]!] : []; }))];
}

interface CandidateLike {
  module: string;
  instance: string | null;
  kind: string;
  label?: string;
  category?: string;
  category_is_new?: boolean;
}

/** Mutates in place, like the fills beside it. Only a candidate on a
 *  module's DEFAULT entry moves; one already in a named list is where the
 *  model put it on purpose. The category is dropped on the way: it was the
 *  list's name, and inside that list it says nothing. Returns how many moved,
 *  for the log.
 *
 *  A move onto a table another candidate already holds is not a second way to
 *  file there, it is the same chip twice: the moved one goes. It arrived with
 *  none of the fills the first one got, and the ISBN backfill then gave a
 *  scanned book's duplicate another edition's number (#3543). */
export function retargetByCategory(candidates: CandidateLike[], menu: readonly ScanMenuEntry[]): number {
  let moved = 0;
  const movedOnes = new Set<CandidateLike>();
  for (const cand of candidates) {
    if (cand.instance) continue;
    if (!cand.category) continue;
    const siblings = menu
      .filter((e) => e.module === cand.module && e.instance)
      .map((e) => ({ instance: e.instance!, label: e.label, noun: e.noun, keywords: [...(e.scan_keywords ?? []), ...heldThings(e)], entry: e }));
    const hit = instanceForCategory(cand.category, siblings);
    if (!hit) continue;
    cand.instance = hit.entry.instance;
    cand.kind = hit.entry.kind;
    cand.label = hit.entry.label;
    delete cand.category;
    delete cand.category_is_new;
    movedOnes.add(cand);
    moved++;
  }
  if (movedOnes.size) {
    const tableOf = (c: CandidateLike) => `${c.module}::${c.instance ?? ""}`;
    const held = new Set(candidates.filter((c) => !movedOnes.has(c)).map(tableOf));
    const kept = candidates.filter((c) => {
      if (!movedOnes.has(c)) return true;
      if (held.has(tableOf(c))) return false;
      held.add(tableOf(c));
      return true;
    });
    candidates.splice(0, candidates.length, ...kept);
  }
  return moved;
}

/** The installed list a said category names, in any module: "Books" is the
 *  Bookshelf (its noun is book), whatever table the thing would otherwise go
 *  to. For a door where the category is said, not guessed (the assistant's
 *  add_thing over chat and MCP): the same rule as above, so a book said to
 *  be one files where a scanned book does (#6037). Null when it names none. */
export function listNamedByCategory(category: unknown, menu: readonly ScanMenuEntry[]): ScanMenuEntry | null {
  if (typeof category !== "string" || !category.trim()) return null;
  const named = menu
    .filter((e) => e.instance)
    .map((e) => ({ instance: e.instance!, label: e.label, noun: e.noun, keywords: [...(e.scan_keywords ?? []), ...heldThings(e)], entry: e }));
  return instanceForCategory(category, named)?.entry ?? null;
}

/** A scanned ISBN is a book whatever a catalog answers, and the list for it
 *  is the one whose records carry an ISBN, found by that field, not by its
 *  name or noun (#6155: a Bookshelf copied from another workspace lost its
 *  noun, and a book no catalog knew went to Inventory). Moves a candidate on
 *  a module's catch-all to that list when exactly one installed list holds
 *  books; a list the model chose on purpose stays. Returns how many moved. */
export function retargetIsbnToBookList(candidates: CandidateLike[], menu: readonly ScanMenuEntry[], code: string | null | undefined): number {
  if (!code || codeKindOf(code) !== "book") return 0;
  const lists = menu.filter((e) => e.instance && !e.bundle_external_id && heldThings(e).includes("book"));
  if (lists.length !== 1) return 0;
  const list = lists[0]!;
  let moved = 0;
  for (const cand of candidates) {
    if (cand.instance) continue;
    cand.module = list.module;
    cand.instance = list.instance;
    cand.kind = list.kind;
    cand.label = list.label;
    moved++;
  }
  if (moved) {
    // One chip per table, as retargetByCategory keeps it.
    const seen = new Set<string>();
    const kept = candidates.filter((c) => { const t = `${c.module}::${c.instance ?? ""}`; if (seen.has(t)) return false; seen.add(t); return true; });
    candidates.splice(0, candidates.length, ...kept);
  }
  return moved;
}
