// One box, routed by WHAT WAS GIVEN.
//
// The scan header used to carry a separate button per intake kind (UPC, URLs,
// Photos, Receipt, Import) plus a search field. But on a desktop the actual
// gestures are "paste a code", "paste a link" and "drop a file" - and which one
// you did is readable from the input itself, so it never needed to be a mode
// the person picks first (reported 2026-08-01: "either those go back to first class
// buttons or Scan is the wrong heading for that dropdown").
//
// Pure and unit-tested: the routing decision is the whole feature, and it must
// never mistake a search for an add. Anything not confidently a code or a link
// stays a SEARCH, because filtering is harmless and a wrong add is not.

export type OmniKind = "upc" | "url" | "urls" | "text";

export interface OmniIntent {
  kind: OmniKind;
  /** Cleaned value: digits for a upc, one url per line for urls. */
  value: string;
  /** Button copy for the add action, null when this is a search. */
  action: string | null;
}

/** Digits only, ignoring the spaces and dashes a printed barcode carries. */
const DIGITS = /^[0-9\s-]+$/;

/** UPC-A/EAN-13/EAN-8/ITF-14 lengths. A bare 5-digit number is a quantity or a
 *  year far more often than a barcode, so it stays a search. */
const BARCODE_LENGTHS = new Set([8, 12, 13, 14]);

function looksLikeUrl(s: string): boolean {
  if (!/^https?:\/\//i.test(s)) return false;
  try {
    // Reject "https://" alone and other unparseable fragments.
    return !!new URL(s).hostname;
  } catch {
    return false;
  }
}

/**
 * What did the person just give us? Called on every keystroke, so it must stay
 * cheap and must not flap between kinds mid-typing.
 */
export function classifyOmni(raw: string): OmniIntent {
  const s = raw.trim();
  if (!s) return { kind: "text", value: "", action: null };

  const lines = s.split(/\s+/).filter(Boolean);
  const urls = lines.filter(looksLikeUrl);
  if (urls.length > 1) {
    return { kind: "urls", value: urls.join("\n"), action: `Add ${urls.length}` };
  }
  // A single url only counts when it is the ENTIRE input - "is this in stock at
  // https://..." is someone searching their own notes, not adding a product.
  if (urls.length === 1 && lines.length === 1) {
    return { kind: "url", value: urls[0]!, action: "Add" };
  }

  if (DIGITS.test(s)) {
    const digits = s.replace(/[\s-]/g, "");
    if (BARCODE_LENGTHS.has(digits.length)) {
      return { kind: "upc", value: digits, action: "Add" };
    }
  }

  return { kind: "text", value: s, action: null };
}

/** Placeholder copy - a phone cannot show the full sentence. */
export function omniPlaceholder(compact: boolean): string {
  // 41 characters was longer than the field at most widths, so it clipped
  // mid-word ("...or dr") and read as broken. Drag-and-drop still works; it
  // just no longer has to be advertised here, now that upload is its own
  // control on the row (reported 2026-08-10).
  return compact ? "Search or paste" : "Search, paste a UPC or link";
}
