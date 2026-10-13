// How far a barcode catalog's answer is trusted, and what the card says about
// it: one place, so the confidence and the sentence cannot disagree.
import { isShortBarcode } from "@cobblr/platform-contract/scan-triage";
import { BRAND_ONLY_NOTE } from "@cobblr/platform-contract/scan-copy";
import { namedByOnePerson, type BarcodeHit } from "./barcode-lookup.js";

const words = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** The catalog's "name" is its brand and nothing more (#6146): go-upc answers
 *  "Al Ambra Perfumes" for a perfume maker's code with no product named. */
export function namesOnlyTheBrand(hit: Pick<BarcodeHit, "title" | "brand">): boolean {
  const t = words(hit.title);
  return !!t && t === words(hit.brand);
}

export function hitVerdict(
  hit: BarcodeHit,
  codeClass: { type: string; code: string },
  provenance = "the barcode network",
): { lowTrust: boolean; brandOnly: boolean; onePerson: boolean; confidence: string | null; notes: string } {
  const onePerson = namedByOnePerson(hit);
  const brandOnly = namesOnlyTheBrand(hit);
  // A short code may resolve to an unrelated item, one person's word is one
  // person's word, and a brand is not a product: each is shown, and asked
  // about, before it is trusted.
  const lowTrust = (codeClass.type === "upc" && isShortBarcode(codeClass.code)) || onePerson || brandOnly;
  const confidence = hit.title ? (lowTrust ? "0.6" : "0.85") : null;
  const notes = onePerson
    ? "Named by one person on the barcode network. Check it, or correct it."
    : brandOnly
      ? BRAND_ONLY_NOTE
      : hit.title
        ? `Identified via ${provenance}.`
        : `Resolved via ${provenance}.`;
  return { lowTrust, brandOnly, onePerson, confidence, notes };
}
