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

export type OmniKind = "upc" | "url" | "urls" | "text" | "cobblr-qr" | "own-route";
import { classifyScanPayload } from "../lib/scanPayload";
import type { OwnRoute } from "../lib/openOwnRoute";
import { looksShared, parseSharedText, type SharedProduct } from "@cobblr/platform-contract/shared-text";

export interface OmniIntent {
  kind: OmniKind;
  /** Cleaned value: digits for a upc, one url per line for urls. */
  value: string;
  /** Button copy for the add action, null when this is a search. */
  action: string | null;
  /** For a link or links: each product with the words it came with, the
   *  title kept as its name (the one parse, @cobblr/platform-contract/shared-text). */
  products?: SharedProduct[];
  /** For a link to a page of this instance: the page, to open with
   *  useOpenOwnRoute, never navigate() (#8874). */
  route?: OwnRoute;
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
export function classifyOmni(raw: string, ownOrigins?: readonly string[]): OmniIntent {
  const s = raw.trim();
  if (!s) return { kind: "text", value: "", action: null };

  // A Cobblr label URL is the place or record it names, never a product page
  // to scrape: the same rule the camera and the typed field apply
  // (lib/scanPayload.ts). It goes where the QR goes.
  const payload = classifyScanPayload(s, ownOrigins);
  if (payload.kind === "own-route") return { kind: "own-route", value: payload.route.href, route: payload.route, action: "Open" };
  if (payload.kind === "cobblr-qr") {
    return { kind: "cobblr-qr", value: payload.token, action: "Open" };
  }

  const lines = s.split(/\s+/).filter(Boolean);
  const urls = lines.filter(looksLikeUrl);
  if (urls.length > 1) {
    const products = parseSharedText(s);
    return { kind: "urls", value: products.map((p) => p.url).join("\n"), action: `Add ${products.length}`, products };
  }
  // A single url counts when it is the ENTIRE input, or when the words with
  // it are a product's title as a shopping app shares it ("Samsung 990 EVO
  // 2TB https://a.co/d/xyz"). "is this in stock at https://..." is someone
  // searching their own notes, not adding a product, and stays a search.
  if (urls.length === 1 && lines.length === 1) {
    return { kind: "url", value: urls[0]!, action: "Add", products: [{ title: null, url: urls[0]! }] };
  }
  if (urls.length === 1 && looksShared(s)) {
    const products = parseSharedText(s);
    return { kind: "url", value: products[0]!.url, action: "Add", products };
  }

  if (DIGITS.test(s)) {
    const digits = s.replace(/[\s-]/g, "");
    if (BARCODE_LENGTHS.has(digits.length)) {
      return { kind: "upc", value: digits, action: "Add" };
    }
  }

  return { kind: "text", value: s, action: null };
}

/** Partition a selection without dropping any files. Images follow photo
 *  intake; documents are each read as a separate receipt. */
export interface FileIntent {
  photos: File[];
  receipts: File[];
}

export function classifyFiles(files: File[]): FileIntent | null {
  if (!files.length) return null;
  const photos: File[] = [];
  const receipts: File[] = [];
  for (const file of files) {
    (file.type.startsWith("image/") ? photos : receipts).push(file);
  }
  return { photos, receipts };
}

/** Placeholder copy - a phone cannot show the full sentence. */
export function omniPlaceholder(compact: boolean): string {
  // 41 characters was longer than the field at most widths, so it clipped
  // mid-word ("...or dr") and read as broken. Drag-and-drop still works; it
  // just no longer has to be advertised here, now that upload is its own
  // control on the row (reported 2026-08-10).
  return compact ? "Search or paste" : "Search, paste a UPC or link";
}
