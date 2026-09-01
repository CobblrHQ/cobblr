// The picture a person chose, remembered for the next scan of the same thing -
// including the things that have no barcode.
//
// Picking a better catalog photo has fed the shared Barcode Intelligence DB
// since it shipped, so the next scan of that UPC in ANY workspace gets the
// clean image. That path is gated on the row having a barcode. A receipt line
// has none: a Lidl till slip says "Baby Carrots" and nothing else, so the
// search ran fresh every time and kept serving a tin of peas and carrots for
// fresh produce - and the picture the user had already chosen was thrown away
// with the row ("I already picked the perfect image for Lidl + baby carrots,
// so that should get saved and re-served to everyone", 2026-08-31).
//
// So: the same feedback, keyed on what a receipt actually gives us - the shop
// and the line's name.
//
// TWO RULES, both load-bearing:
//
//   1. ONLY A PUBLIC URL IS SHAREABLE. A picked FILE lives in the workspace
//      that picked it and is meaningless (and unreadable) to anyone else, and
//      publishing someone's own camera roll to every workspace on the instance
//      is not a caching decision to make quietly. A pick from the web strip is
//      already a public address; that is the only thing that travels.
//
//   2. IT MUST BE FORGETTABLE. A shared store with no eviction has no way to
//      be wrong safely - the lesson the barcode cache paid for when a pack of
//      silicone ties became "411 - White Pages" for the whole instance. `forget`
//      is the third option: we no longer believe this, take a fresh look.

import { platform } from "@cobblr/platform-contract";

export const PICKED_IMAGE_NS = "product-image";

/**
 * The identity a receipt line has: the shop it came from and what it was
 * called. Normalised so "Baby Carrots" and "baby  carrots" are one key, and
 * scoped by vendor because a shop's own-brand item is a different product from
 * another shop's line of the same name.
 *
 * Null when there is not enough to be sure. A bare name with no vendor is NOT
 * enough to publish to every workspace: "Tomatoes Roma" from an unknown shop
 * would bind one shop's picture to everyone else's different product.
 */
export function pickedImageKey(vendor: string | null | undefined, name: string | null | undefined): string | null {
  const norm = (v: string) =>
    v
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .replace(/\s+/g, " ");
  const shop = norm(vendor ?? "");
  const what = norm(name ?? "");
  // A one-character name is not an identity, and a name long enough to be a
  // whole product description is unlikely to repeat - both make poor keys.
  if (!shop || what.length < 2 || what.length > 120) return null;
  return `${shop}|${what}`;
}

interface PickedImage {
  url: string;
  /** Who chose it, kept so a bad entry can be traced rather than merely deleted. */
  orgId: string;
  at: string;
}

/** Only an http(s) address travels between workspaces - see rule 1. */
function shareableUrl(url: string | null | undefined): string | null {
  const u = (url ?? "").trim();
  if (!/^https?:\/\//i.test(u)) return null;
  // A loopback/relative api path is this instance's own file route, not a
  // public picture: it would resolve to a different workspace's file, or to
  // nothing at all, for whoever read it next.
  if (/\/api\/v1\/orgs\//.test(u)) return null;
  return u;
}

/** Remember the picture a person chose for this shop + product. */
export async function rememberPickedImage(
  orgId: string,
  vendor: string | null | undefined,
  name: string | null | undefined,
  url: string | null | undefined,
): Promise<boolean> {
  const key = pickedImageKey(vendor, name);
  const shareable = shareableUrl(url);
  if (!key || !shareable) return false;
  const entry: PickedImage = { url: shareable, orgId, at: new Date().toISOString() };
  // No TTL: a chosen picture is stable reference data, the same reason a
  // resolved product has none. It changes when a person changes it.
  await platform().sharedCache.put(PICKED_IMAGE_NS, key, entry);
  return true;
}

/** The picture someone already chose for this shop + product, or null. */
export async function pickedImageUrl(
  vendor: string | null | undefined,
  name: string | null | undefined,
): Promise<string | null> {
  const key = pickedImageKey(vendor, name);
  if (!key) return null;
  try {
    const hit = await platform().sharedCache.get<PickedImage>(PICKED_IMAGE_NS, key);
    return shareableUrl(hit?.url);
  } catch {
    // A remembered picture is an optimisation; never let it break the enrich.
    return null;
  }
}

/** Stop believing it - the eviction rule 2 exists for. */
export async function forgetPickedImage(
  vendor: string | null | undefined,
  name: string | null | undefined,
): Promise<void> {
  const key = pickedImageKey(vendor, name);
  if (key) await platform().sharedCache.del(PICKED_IMAGE_NS, key);
}
