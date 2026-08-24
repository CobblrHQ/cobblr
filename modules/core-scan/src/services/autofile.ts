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
}

export type AutofilePlan =
  | { action: "attach"; itemId: string; to: TrackedCandidate; qty: number; why: string }
  | { action: "create"; itemId: string; qty: number; why: string }
  | { action: "skip"; itemId: string; why: string };

/**
 * What to do with one item, decided without touching anything.
 *
 * Ordered by how much the evidence is worth: a barcode is the product's own
 * identity, a name is an opinion about it, and the matchmaker's candidate is a
 * guess about where a NEW record should go.
 */
export function planItem(item: AutofileItem): AutofilePlan {
  const qty = Math.max(1, Math.trunc(Number(item.quantity ?? 1)));

  // A barcode is the product saying what it is. One match is decisive.
  if (item.barcodeMatches.length === 1) {
    return { action: "attach", itemId: item.id, to: item.barcodeMatches[0]!, qty, why: "same barcode" };
  }
  // Two records with the same barcode is a mess somebody made earlier, and
  // guessing which one to feed would deepen it.
  if (item.barcodeMatches.length > 1) {
    return {
      action: "skip",
      itemId: item.id,
      why: `${item.barcodeMatches.length} things already have this barcode`,
    };
  }

  if (item.nameMatches.length === 1) {
    return { action: "attach", itemId: item.id, to: item.nameMatches[0]!, qty, why: "matches by name" };
  }
  if (item.nameMatches.length > 1) {
    // "Organic Green Tea" against three teas. A person settles this in a second
    // and a machine cannot settle it at all.
    return {
      action: "skip",
      itemId: item.id,
      why: `could be any of ${item.nameMatches.length} things you already have`,
    };
  }

  // Nothing matched: this is new. Create it, but only where the matchmaker is
  // confident enough that "File all" would have created it anyway - this button
  // is a bulk version of a decision, not a lowering of the bar for it.
  if (!item.suggested_name) {
    return { action: "skip", itemId: item.id, why: "no name to file it under" };
  }
  if (!item.candidate?.module || !item.candidate?.kind) {
    return { action: "skip", itemId: item.id, why: "nowhere obvious to put it" };
  }
  return { action: "create", itemId: item.id, qty, why: "nothing like it yet" };
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
export function describeSummary(s: AutofileSummary): string {
  const bits: string[] = [];
  if (s.attached) bits.push(`added to ${s.attached} you already had`);
  if (s.created) bits.push(`filed ${s.created} new`);
  if (bits.length === 0 && s.skipped === 0) return "Nothing was waiting.";
  if (bits.length === 0) return `Nothing filed. ${s.skipped} need a look.`;
  const head = bits.join(", ");
  if (s.skipped === 0) return `${head}.`;
  const top = Object.entries(s.reasons).sort((a, b) => b[1] - a[1])[0];
  return `${head}. ${s.skipped} left for you${top ? ` — mostly: ${top[0]}` : ""}.`;
}
