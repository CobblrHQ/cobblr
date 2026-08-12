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

/** What a set of FILES handed to the box should become. Same question
 *  classifyOmni answers for text, and the same box asks it: a file can arrive
 *  by drag-and-drop or by pasting a screenshot, and both are the same intake.
 *
 *  Routing is by type, not by how it arrived, which is why the two entry points
 *  share this. Note the known limitation it inherits: an IMAGE of a receipt is
 *  routed to photo intake, because nothing here can tell a photographed receipt
 *  from a photographed product. That is stated and specced in
 *  docs/design-decisions/receipt-from-a-photo.md; when it is fixed, it is fixed
 *  here, once, for drop and paste together. */
export type FileIntent =
  | { kind: "photos"; files: File[] }
  | { kind: "receipt"; file: File }
  | null;

export function classifyFiles(files: File[]): FileIntent {
  if (!files.length) return null;
  const images = files.filter((f) => f.type.startsWith("image/"));
  // ALL images -> one photo session. A mixed selection is treated as a
  // document drop, because the non-image is the specific thing the user meant.
  if (images.length === files.length) return { kind: "photos", files: images };
  const first = files[0];
  return first ? { kind: "receipt", file: first } : null;
}

/** The image files on a clipboard, or [] when it carries none.
 *
 *  A paste is only intake when there is actually an image on the clipboard.
 *  Pasting a UPC, a link or a search term has to keep landing in the field, so
 *  the caller must check this is non-empty BEFORE calling preventDefault -
 *  swallowing a text paste would break the box's main job to serve its rarer
 *  one. */
export function clipboardImages(data: DataTransfer | null | undefined): File[] {
  return Array.from(data?.files ?? []).filter((f) => f.type.startsWith("image/"));
}

/** Placeholder copy - a phone cannot show the full sentence. */
export function omniPlaceholder(compact: boolean): string {
  // 41 characters was longer than the field at most widths, so it clipped
  // mid-word ("...or dr") and read as broken. Drag-and-drop still works; it
  // just no longer has to be advertised here, now that upload is its own
  // control on the row (reported 2026-08-10).
  return compact ? "Search or paste" : "Search, paste a UPC or link";
}
