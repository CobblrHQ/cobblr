// "Looks like the same product" — the clustering behind the inbox's Combine offer.
//
// Pure + unit-tested (scanCombine.test.ts). Extracted from ScanPage for the same
// reason scanFiling.ts was: this is a DECISION, and a decision that got a real
// case wrong deserves a test, not a page component.

import type { ScanInboxItem } from "./api";

const COMBINE_STOP = new Set([
  "the", "and", "for", "with", "ultra", "soft", "pack", "count", "new", "size", "per", "each",
]);

export function nameTokens(s: string | null | undefined): Set<string> {
  return new Set(
    (s ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !/^\d+$/.test(w) && !COMBINE_STOP.has(w)),
  );
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

/** The name's words with the BRAND's words removed — what's left is the product. */
export function productTokens(name: string | null | undefined, brand: string): Set<string> {
  const brandToks = nameTokens(brand);
  return new Set([...nameTokens(name)].filter((w) => !brandToks.has(w)));
}

/** Titled works — books, movies, albums — are NOT combinable by name: their
 *  "brand" is a publisher/studio shared across a whole catalog, and series titles
 *  overlap heavily ("Little TOWN on the Prairie" vs "Little HOUSE on the Prairie"
 *  share little+prairie → falsely "the same product"). The differing word IS the
 *  identity. Barcode-match combine still applies — that's identity, not overlap. */
const TITLED_MEDIA_FIELD = /^(author|isbn|director|artist|composer|writer|edition|publisher|issn)$/i;
export function isTitledMedia(it: ScanInboxItem): boolean {
  return (it.suggested_candidates ?? []).some((c) =>
    Object.keys(c.fields ?? {}).some((k) => TITLED_MEDIA_FIELD.test(k)),
  );
}

/** Unit-ish tokens ("75mm", "10pk", "120v") are measurements, not identity —
 *  they must neither count as model numbers nor veto anything. */
const UNIT_TOKEN = /^\d+(pk|ct|pcs?|oz|ml|lb|kg|mm|cm|in|ft|gal|qt|ah|mah|[wvagl])$/;

/** Tokens that read as MODEL NUMBERS: letters+digits interleaved ("F27T350FHN",
 *  "S23A300B", "MSB1G"). A model number IS the product's identity — two names
 *  whose model numbers disagree are different products no matter how many
 *  generic words ("inch", "monitor") they share. Exported for tests. */
export function modelNumberTokens(s: string | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const w of (s ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)) {
    if (w.length < 4 || UNIT_TOKEN.test(w)) continue;
    const letters = (w.match(/[a-z]/g) ?? []).length;
    const digits = (w.match(/[0-9]/g) ?? []).length;
    if (letters >= 2 && digits >= 1) out.add(w);
  }
  return out;
}

/** A barcode a CATALOG resolved is an identity, not a guess. An AI-read one
 *  (OCR'd off a package by the vision model) can be misread a digit at a time, so
 *  it doesn't get to veto anything. */
function catalogBarcode(it: ScanInboxItem): string | null {
  const meta = (it.suggested_metadata ?? {}) as { barcode_source?: string };
  if (!it.barcode_text || meta.barcode_source === "ai-photo") return null;
  return it.barcode_text;
}
function packSize(it: ScanInboxItem): number | null {
  return ((it.suggested_metadata ?? {}) as { pack_size?: number }).pack_size ?? null;
}

/**
 * Would combining these two into ONE record be right?
 *
 * The BARCODES answer first, because they are facts and word overlap is a guess.
 * Overlap alone was offering to merge a Leviton **wall plate** with a Leviton
 * **rocker switch**: same brand, and they share `decora` (a product LINE) and
 * `white` (a COLOUR), which cleared the old "≥2 shared words" bar. Half of
 * Leviton's catalog shares those two words — they carry no identity whatsoever.
 * Meanwhile both items had different, catalog-resolved UPCs sitting right there,
 * saying plainly that they are different products.
 *
 *   same catalog barcode        → the same product, full stop.
 *   different catalog barcodes  → different SKUs. The one honest exception is a
 *                                 multipack of the same unit (a 10-pack carries
 *                                 its own UPC) — detected from the PACK SIZE, not
 *                                 from word overlap.
 *   no catalog barcode          → the name is all we have; use it (deliberately
 *                                 eager: it's an offer, and "Charmin Toilet Paper"
 *                                 vs "Charmin Bath Tissue Jumbo Roll" needs it).
 */
export function combinable(
  a: ScanInboxItem,
  b: ScanInboxItem,
  seed: Set<string>,
  brand: string,
): boolean {
  if ((b.suggested_manufacturer ?? "").trim().toLowerCase() !== brand) return false;

  const codeA = catalogBarcode(a);
  const codeB = catalogBarcode(b);
  if (codeA && codeB && codeA === codeB) return true; // identity — no name guessing needed

  // DIFFERENT MODEL NUMBERS = DIFFERENT PRODUCTS. Two 27"/23" monitors shared
  // "inch" + "monitor" and cleared the word bar while their model numbers
  // (F27T350FHN vs S23A300B) disagreed in plain sight. When BOTH names carry
  // model-number tokens and NONE match, no amount of generic-word overlap (or
  // the multipack exception) may combine them — only an identical catalog
  // barcode above outranks this.
  const modelsA = modelNumberTokens(a.suggested_name);
  const modelsB = modelNumberTokens(b.suggested_name);
  if (modelsA.size && modelsB.size && ![...modelsA].some((m) => modelsB.has(m))) return false;

  if (codeA && codeB) {
    const packA = packSize(a);
    const packB = packSize(b);
    const onePack = (packA === null) !== (packB === null);
    if (!onePack) return false;
    return jaccard(seed, productTokens(b.suggested_name, brand)) >= 0.6;
  }

  const product = productTokens(b.suggested_name, brand);
  let shared = 0;
  for (const w of product) if (seed.has(w)) shared++;
  return shared >= 2 || jaccard(seed, product) >= 0.5;
}

/** Cluster pending items that look like the same product, so the inbox can OFFER
 *  to combine them. Each candidate is compared to the cluster's SEED (its first
 *  member) so a cluster can't drift member-to-member into a different product. */
export function findCombineClusters(items: ScanInboxItem[]): ScanInboxItem[][] {
  const clusters: { brand: string; seed: Set<string>; head: ScanInboxItem; items: ScanInboxItem[] }[] = [];
  for (const it of items) {
    if (isTitledMedia(it)) continue; // a different title = a different work
    const brand = (it.suggested_manufacturer ?? "").trim().toLowerCase();
    if (!brand || !it.suggested_name) continue;
    const product = productTokens(it.suggested_name, brand);
    if (product.size === 0) continue;
    const hit = clusters.find((c) => combinable(c.head, it, c.seed, c.brand));
    if (hit) hit.items.push(it);
    else clusters.push({ brand, seed: product, head: it, items: [it] });
  }
  return clusters.filter((c) => c.items.length >= 2).map((c) => c.items);
}
