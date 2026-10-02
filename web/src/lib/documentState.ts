// Where reading an inbox session's document stands, in words: the line under
// the document's name on its card (DocumentSessionCard).
//
// A scanned PDF says so ("Scanned PDF, read from its image"), because its
// lines came from a photo of the page rather than from text in the file, and
// a person deciding whether to trust them should know that (#4523).
import type { SessionVerdict } from "@cobblr/platform-contract/scan-session";

function fromScan(v: SessionVerdict, items: ReadonlyArray<{ suggested_metadata?: unknown }>): boolean {
  if (v.kind === "failed") return v.failure.source === "scanned-pdf";
  return items.some((i) => (i.suggested_metadata as { receipt_source?: unknown } | null | undefined)?.receipt_source === "scanned-pdf");
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
      return scan ? `Scanned PDF, read from its image into ${read}` : `Read into ${read}`;
    case "empty":
      return scan ? "Scanned PDF, read from its image; every line is dealt with" : "Read, and every line is dealt with";
    default:
      return null;
  }
}
