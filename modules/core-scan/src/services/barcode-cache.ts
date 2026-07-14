// The barcode caches — and how to forget a bad answer.
//
// A resolved UPC is cached twice: per-tenant (fast) and in the SHARED
// cross-workspace store (the Barcode Intelligence DB), where it becomes the answer
// for the next workspace that scans the same code.
//
// That second one is the reason this file exists. A shared cache with no eviction
// has no way to be WRONG safely: once a bad name is in, every workspace on the
// instance inherits it, and the only recourse is to overwrite it with another
// guess. A pack of Harbor Freight silicone ties resolved to "411 - White Pages |
// Find Phone Numbers" (a bare UPC reads as a phone number to a search engine), and
// that was one write away from being the canonical name of that product for
// everyone.
//
// Lives in its own module because BOTH enrich.ts and enrich-photo.ts need it, and
// enrich.ts already imports enrich-photo.ts — putting it in either would close a
// circular import.

import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { CoreScanDB } from "../db.js";

export const BARCODE_NS = "barcode";

/**
 * Forget everything we think we know about this barcode — locally AND for every
 * other workspace.
 *
 * Called when the stored answer is DISPROVED (the user's photo shows a different
 * product). Eviction, not overwrite: the photo is strong evidence about THIS item,
 * but not authoritative enough to make one workspace's guess into the whole
 * instance's truth. The next scan takes a fresh look; the correction rides the
 * reviewable channel (`reportBarcodeCorrection`) instead.
 *
 * Without this, a corrected item was a lie with a short half-life: the item read
 * right, and the very next scan of the same code re-served the same wrong product
 * straight from the cache that had just been disproved.
 */
export async function evictBarcodeCaches(orgId: string, upc: string): Promise<void> {
  const code = upc.trim();
  if (!code) return;
  try {
    const db = (await platform().tenants.getDb(orgId)) as unknown as Kysely<CoreScanDB>;
    await db.deleteFrom("core_scan_barcode_cache").where("upc", "=", code).execute();
  } catch {
    /* best-effort: the shared eviction below matters more. */
  }
  await platform().sharedCache.del(BARCODE_NS, code);
}
