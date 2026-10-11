// Where reading an inbox session's document stands, in words: the line under
// the document's name on its card (DocumentSessionCard).
//
// A scanned PDF says so ("Scanned PDF, read from its image"), because its
// lines came from a photo of the page rather than from text in the file, and
// a person deciding whether to trust them should know that (#4523).
import type { SessionVerdict } from "@cobblr/platform-contract/scan-session";
import { documentChipWords } from "@cobblr/platform-contract/scan-source";

function fromScan(v: SessionVerdict, items: ReadonlyArray<{ suggested_metadata?: unknown }>): boolean {
  if (v.kind === "failed") return v.failure.source === "scanned-pdf";
  return items.some((i) => (i.suggested_metadata as { receipt_source?: unknown } | null | undefined)?.receipt_source === "scanned-pdf");
}

/** Lines read by code from the order itself, with no model asked: the email's
 *  own layout, or the store's order page. Said on the card, because a person
 *  weighing a read should know no AI guessed at it. */
function readWithNoModel(items: ReadonlyArray<{ suggested_metadata?: unknown }>): "email" | "page" | null {
  const methods = items.map((i) => (i.suggested_metadata as { parse_method?: unknown } | null | undefined)?.parse_method);
  if (!methods.length) return null;
  if (methods.every((m) => m === "order-email")) return "email";
  if (methods.every((m) => m === "order-page")) return "page";
  return null;
}

/** A bill of sale says so: it is one thing and its purchase, not a till
 *  receipt's lines. */
function isBillOfSale(items: ReadonlyArray<{ suggested_metadata?: unknown }>): boolean {
  return items.some((i) => (i.suggested_metadata as { receipt_document?: unknown } | null | undefined)?.receipt_document === "bill-of-sale");
}

export function documentStateWords(v: SessionVerdict, items: ReadonlyArray<{ suggested_metadata?: unknown }>): string | null {
  const scan = fromScan(v, items);
  const lines = items.length;
  const read = lines === 1 ? "1 line" : `${lines} lines`;
  switch (v.kind) {
    case "failed":
      return scan ? "Scanned PDF, couldn't read yet" : "Couldn't read yet";
    case "in_flight":
      return "Reading it now";
    case "read":
      if (isBillOfSale(items)) return scan ? "Bill of sale, read from its scan" : "Bill of sale, read";
      if (scan) return `Scanned PDF, read from its image into ${read}`;
      if (readWithNoModel(items) === "email") return `Read from the order email, no AI, into ${read}`;
      if (readWithNoModel(items) === "page") return `Read from the store's order page, no AI, into ${read}`;
      return `Read into ${read}`;
    case "empty":
      return scan ? "Scanned PDF, read from its image; every line is dealt with" : "Read, and every line is dealt with";
    default:
      return null;
  }
}

/** The header chip of a session that needs nothing ("Email · 3 lines"). A
 *  read with no model says so here too: the card that says it is only shown
 *  when the document needs the person, so a good read never said it. */
export function documentChipLine(kind: string, items: ReadonlyArray<{ suggested_metadata?: unknown }>): string {
  return `${documentChipWords(kind, items.length)}${readWithNoModel(items) ? ", no AI" : ""}`;
}

/** What a Read again says when it is done: how many lines, and the purchase
 *  they are on, so filing them is known to file that order. */
export function readAgainWords(r: { receipt: { item_count: number }; purchase?: { recorded: boolean; order_number?: string | null } | null }): string {
  const n = r.receipt.item_count;
  const lines = `Read again: ${n} item${n === 1 ? "" : "s"}`;
  if (!r.purchase?.recorded) return lines;
  return r.purchase.order_number ? `${lines}, on purchase #${r.purchase.order_number}` : `${lines}, on its purchase`;
}
