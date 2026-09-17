// One button for a full inbox: file everything that can be filed, adding to what
// you already have rather than making a second one of it.
//
// Both halves already existed and were never joined. `findTracked` matches a
// scan against things you already track, by barcode and by name overlap.
// `attach` with `mode: add-qty` bumps an existing record's quantity and files
// the purchase in the consumption ledger. And "File all" files a whole session -
// but only ever by CREATING, using the matchmaker's suggested candidate.
//
// So a receipt with "3 cucumbers" made a second Cucumbers next to the two you
// had. Do that weekly and the cupboard fills with duplicates, at which point the
// cadence engine is learning from a dozen records that are all the same food and
// none of them has a usable history.
//
// THE RULE THAT MATTERS: ambiguity never auto-resolves. Attaching to the wrong
// record is worse than doing nothing, because it silently inflates the stock of
// something you did not buy and there is no error anywhere to notice. Two
// plausible matches means the item stays pending for a person to settle.
//
// And a row the pipeline itself flagged for review is never filed by a sweep,
// however good its match: the flag exists to hold that commit until a person
// has looked (the platform contract's readiness rule, scan-triage.ts). The
// plan lists it under "left for you" with the reason, never as "filed as new"
// (#2980).

import { filedQuantityOf } from "./filed-quantity.js";

/** What findTracked gives back, narrowed to what the decision needs. */
export interface TrackedCandidate {
  kind: string;
  id: string;
  title: string;
  instance?: string | null;
  matched_by?: string | null;
}

export interface InboxCandidate {
  module?: string;
  /** The entity kind to create. Carried by the candidate rather than derived,
   *  so core-scan never has to know how another module names its kinds. */
  kind?: string;
  instance?: string | null;
  /** Set when the route is a flagship bundle this workspace has not installed
   *  yet: the table does not exist until the bundle does. */
  bundle_external_id?: string | null;
  /** What the destination table is called ("Groceries"), for the plan the
   *  person reads. */
  label?: string;
  confidence?: number;
  fields?: Record<string, unknown>;
}

export interface AutofileItem {
  id: string;
  suggested_name?: string | null;
  quantity?: number | null;
  /** The matchmaker's routing suggestion, used only when nothing is matched. */
  candidate?: InboxCandidate | null;
  /** Things already tracked that look like this one. */
  barcodeMatches: TrackedCandidate[];
  nameMatches: TrackedCandidate[];
  /** Whether the person confirming may install a bundle (owner or admin).
   *  Filing into a table that does not exist yet means installing it first,
   *  and that changes what the workspace is made of. */
  canInstall?: boolean;
  /** Why the row still needs a person (scanReviewReason), or null when
   *  nothing is flagged. Set, the row is left for them whatever else matched. */
  review?: string | null;
}

/** One line of the plan a person reads before confirming. `name` is the
 *  item's, on every line: a sheet that says "+2 to Cucumbers, same barcode"
 *  has to say what the 2 are. A create names its destination table, and
 *  `installs` when that table has to be installed on the way. */
export type AutofilePlan =
  | { action: "attach"; itemId: string; name: string | null; to: TrackedCandidate; qty: number; why: string }
  | { action: "create"; itemId: string; name: string | null; destination: string | null; installs?: string | null; qty: number; why: string }
  | { action: "skip"; itemId: string; name: string | null; why: string };

/**
 * What to do with one item, decided without touching anything.
 *
 * Ordered by how much the evidence is worth: a barcode is the product's own
 * identity, a name is an opinion about it, and the matchmaker's candidate is a
 * guess about where a NEW record should go.
 */
export function planItem(item: AutofileItem): AutofilePlan {
  const qty = filedQuantityOf(item.quantity);
  const name = item.suggested_name?.trim() || null;

  // Flagged for review: a person looks before anything commits, and the
  // reason is the line they read. Before the matches on purpose; a decisive
  // barcode on a row whose crop failed is still a row somebody asked to see.
  if (item.review) {
    return { action: "skip", itemId: item.id, name, why: item.review };
  }

  // A barcode is the product saying what it is. One match is decisive.
  if (item.barcodeMatches.length === 1) {
    return { action: "attach", itemId: item.id, name, to: item.barcodeMatches[0]!, qty, why: "same barcode" };
  }
  // Two records with the same barcode is a mess somebody made earlier, and
  // guessing which one to feed would deepen it.
  if (item.barcodeMatches.length > 1) {
    return {
      action: "skip",
      itemId: item.id,
      name,
      why: `${item.barcodeMatches.length} things already have this barcode`,
    };
  }

  if (item.nameMatches.length === 1) {
    return { action: "attach", itemId: item.id, name, to: item.nameMatches[0]!, qty, why: "matches by name" };
  }
  if (item.nameMatches.length > 1) {
    // "Organic Green Tea" against three teas. A person settles this in a second
    // and a machine cannot settle it at all.
    return {
      action: "skip",
      itemId: item.id,
      name,
      why: `could be any of ${item.nameMatches.length} things you already have`,
    };
  }

  // Nothing matched: this is new. Create it, but only where the matchmaker is
  // confident enough that "File all" would have created it anyway - this button
  // is a bulk version of a decision, not a lowering of the bar for it.
  if (!name) {
    return { action: "skip", itemId: item.id, name, why: "no name to file it under" };
  }
  if (!item.candidate?.module || !item.candidate?.kind) {
    return { action: "skip", itemId: item.id, name, why: "nowhere obvious to put it" };
  }
  const destination = item.candidate.label?.trim() || item.candidate.instance || null;
  // The route can point at a table this workspace does not have yet (a fresh
  // workspace's first receipt routes to Groceries before Groceries exists).
  // Filing there means installing the bundle first, which File all already
  // does; a plan that promised the table and then 404'd on every line was
  // what this button did on its first real receipt (2026-09-12). Someone who
  // cannot install gets an honest "left for you" instead of a failure.
  if (item.candidate.bundle_external_id) {
    if (!item.canInstall) {
      return { action: "skip", itemId: item.id, name, why: `needs the ${destination ?? "right"} table, which an owner or admin can install` };
    }
    return { action: "create", itemId: item.id, name, destination, installs: destination, qty, why: "nothing like it yet" };
  }
  return { action: "create", itemId: item.id, name, destination, qty, why: "nothing like it yet" };
}

/** Did the plan a person looked at still hold when they confirmed? The same
 *  action, and for an attach the same record. Anything else means the world
 *  moved between the look and the press (a match filed from another device),
 *  and acting on the new plan would write something they never saw. */
export function planStillHolds(
  seen: { action: string; to_id?: string | null; destination?: string | null },
  now: AutofilePlan,
): boolean {
  if (seen.action !== now.action) return false;
  if (now.action === "attach") return (seen.to_id ?? null) === now.to.id;
  // A create's target is its table: "into Groceries" shown, "into Inventory"
  // now (the bundle uninstalled in between) is a different plan. A client
  // that showed no destination has nothing to hold it to.
  if (now.action === "create" && seen.destination !== undefined) return (seen.destination ?? null) === (now.destination ?? null);
  return true;
}

export interface AutofileSummary {
  attached: number;
  created: number;
  skipped: number;
  /** Why things were left, grouped, so the message names the work remaining
   *  rather than just counting it. */
  reasons: Record<string, number>;
}

export function summarise(plans: AutofilePlan[]): AutofileSummary {
  const reasons: Record<string, number> = {};
  let attached = 0;
  let created = 0;
  let skipped = 0;
  for (const p of plans) {
    if (p.action === "attach") attached++;
    else if (p.action === "create") created++;
    else {
      skipped++;
      reasons[p.why] = (reasons[p.why] ?? 0) + 1;
    }
  }
  return { attached, created, skipped, reasons };
}

/**
 * What to tell the person afterwards.
 *
 * Names what was added to rather than only counting, because "added to 3 you
 * already had" is the sentence that tells them the duplicate problem is not
 * happening. And it says what is LEFT and why, since a silent 12-of-45 reads as
 * a failure.
 */
export function describeSummary(s: AutofileSummary, failed = 0): string {
  const bits: string[] = [];
  if (s.attached) bits.push(`added to ${s.attached} you already had`);
  if (s.created) bits.push(`filed ${s.created} new`);
  // A line that could not be filed is neither filed nor left by choice. It
  // stays in the inbox and the sentence has to say so; "Nothing was waiting"
  // over two failures is what the first real receipt got (2026-09-12).
  const tail = failed ? ` ${failed} could not be filed and stay in the inbox.` : "";
  if (bits.length === 0 && s.skipped === 0) return failed ? `Nothing filed.${tail}` : "Nothing was waiting.";
  if (bits.length === 0) return `Nothing filed. ${s.skipped} need a look.${tail}`;
  const head = bits.join(", ");
  if (s.skipped === 0) return `${head}.${tail}`;
  const top = Object.entries(s.reasons).sort((a, b) => b[1] - a[1])[0];
  return `${head}. ${s.skipped} left for you${top ? ` — mostly: ${top[0]}` : ""}.${tail}`;
}
