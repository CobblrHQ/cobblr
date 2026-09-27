// A photo with no barcode, known by its label's product words (#3769).
//
// The identify already reads a product's words off its label into the name,
// brand, colour and series it returns. Those words (and only those, never the
// photo, never its other text) are the key: filed once, the product is known
// to the next photo whose identify reads the same words. The shared network
// hashes them with a key that never leaves it; words that are not in the
// product itself are never sent (filterToFiled), and a lookup sends only words
// the identify itself put into the product.

import type { PhotoIdentity } from "./enrich-photo.js";

const STOP = new Set(["the", "and", "for", "with", "of", "a", "an", "in", "on", "by", "to", "from", "new", "pack", "item"]);

function tokens(text: string | null | undefined): string[] {
  return String(text ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9.]+/)
    .map((w) => w.replace(/^\.+|\.+$/g, ""))
    .filter(Boolean);
}

/** A word that describes a product: letters (a brand, a product, a colour), or
 *  a size with its unit ("3.5oz", "500ml"). A bare number (a lot, a phone, a
 *  street number) is never a product word. */
function productWord(w: string): boolean {
  if (!/^[a-z0-9][a-z0-9.-]{1,29}$/.test(w) || STOP.has(w)) return false;
  return /[a-z]/.test(w) && (/^[a-z]/.test(w) || /^\d+(\.\d+)?[a-z]{1,4}$/.test(w));
}

/** The product words an identity carries: its name, brand, colour and series,
 *  as the identify read them off the label. */
export function labelWordsOf(identity: Pick<PhotoIdentity, "name" | "brand" | "color" | "series">): string[] {
  const all = [identity.name, identity.brand, identity.color, identity.series].flatMap(tokens).filter(productWord);
  return [...new Set(all)].slice(0, 40);
}

/** Of the label's words, only those also in the product the person filed. Any
 *  other text never leaves the workspace. */
export function filterToFiled(
  words: readonly string[],
  filed: { name?: string | null; brand?: string | null; category?: string | null; color?: string | null },
): string[] {
  const inFiled = new Set([filed.name, filed.brand, filed.category, filed.color].flatMap(tokens));
  return [...new Set(words.filter((w) => productWord(w) && inFiled.has(w)))];
}

/** Where label words go: the box resolver when configured, else the network's
 *  edge; null when neither (the feature is simply off). */
export function labelTarget(env: NodeJS.ProcessEnv = process.env): { match: string; confirm: string; readToken: string; writeToken: string } | null {
  const resolver = (env.COBBLR_BARCODE_RESOLVER_URL ?? "").replace(/\/+$/, "");
  if (resolver && env.COBBLR_BARCODE_RESOLVER_TOKEN) {
    return {
      match: `${resolver}/label-match`,
      confirm: `${resolver}/label-confirm`,
      readToken: env.COBBLR_BARCODE_RESOLVER_TOKEN,
      writeToken: env.COBBLR_BARCODE_RESOLVER_CORRECTION_TOKEN ?? "",
    };
  }
  const bidb = (env.COBBLR_BIDB_URL ?? "").replace(/\/+$/, "");
  const key = (env.COBBLR_BIDB_KEY ?? "").trim();
  if (bidb && key) return { match: `${bidb}/v1/label-match`, confirm: `${bidb}/v1/label-confirm`, readToken: key, writeToken: key };
  return null;
}

export interface LabelMatch {
  name: string;
  brand: string | null;
  category: string | null;
  /** "single": one person filed it; "confident": two or more agree. */
  confidence: "single" | "confident";
}

/** What the network knows for a photo's label words, or null (unknown, too few
 *  words, off, or it could not be asked: the AI's answer then stands). */
export async function matchLabelWords(words: readonly string[]): Promise<LabelMatch | null> {
  const target = labelTarget();
  if (!target || words.length < 3) return null;
  try {
    const res = await fetch(target.match, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${target.readToken}` },
      body: JSON.stringify({ words }),
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return null;
    const d = (await res.json()) as { found?: boolean; name?: unknown; brand?: unknown; category?: unknown; confidence?: unknown };
    if (!d.found || typeof d.name !== "string" || !d.name.trim()) return null;
    return {
      name: d.name.trim(),
      brand: typeof d.brand === "string" ? d.brand : null,
      category: typeof d.category === "string" ? d.category : null,
      confidence: d.confidence === "confident" ? "confident" : "single",
    };
  } catch {
    return null;
  }
}
