// The identify pass for a typed identifier (#3049): a model, part or serial
// number a person typed ("PB287Q"), looked up on the web the way a scanned
// code with no catalog hit is. Heuristic first: the search engine's page
// titles are gathered and their agreement measured before any model is
// asked, and only a CORROBORATED answer (titles that agree, or a model that
// agreed with real titles) replaces what the person typed. An uncorroborated
// guess is held in the metadata and the typed text stays the name: blank
// beats wrong, and here the person's own words beat blank.

import type { Kysely } from "kysely";
import type { CoreScanDB } from "../db.js";
import { resolveBarcodeViaWebSearch } from "./barcode-websearch.js";
import { webSearchEnabled } from "./barcode-lookup.js";
import { replayingWeb } from "./web-replay.js";
import { catalogImageUrlOrNull, downloadCatalogImage, isJunkName, withBrandPrefix } from "./enrich.js";
import { parsePackSize } from "./enrich-photo.js";
import { identityMeta, mergeMeta } from "./metadata.js";

export type IdentifyIdentifierOutcome = "named" | "held" | "off";

export async function identifyTypedIdentifier(opts: {
  db: Kysely<CoreScanDB>;
  orgId: string;
  itemId: string;
  /** The identifier as typed (brand word included when there was one). */
  code: string;
  userId: string | null;
}): Promise<IdentifyIdentifierOutcome> {
  const { db, itemId, code } = opts;
  if (!webSearchEnabled() && !replayingWeb()) {
    await db
      .updateTable("core_scan_inbox_items")
      .set({
        ai_notes: `Web lookups are off on this instance, so ${code} was not looked up. Kept the name you typed.`,
        suggested_metadata: mergeMeta({ identifier: code }) as never,
        ai_suggested_at: new Date(),
        updated_at: new Date(),
      })
      .where("id", "=", itemId)
      .execute();
    return "off";
  }
  const web = await resolveBarcodeViaWebSearch(opts.orgId, code, null, opts.userId, { kind: "identifier" }).catch(() => null);
  if (web && web.corroborated && !isJunkName(web.name)) {
    const name = withBrandPrefix(web.name, web.brand) ?? web.name;
    await db
      .updateTable("core_scan_inbox_items")
      .set({
        suggested_name: name.slice(0, 300),
        suggested_manufacturer: web.brand,
        suggested_sku: web.sku ?? code,
        catalog_image_url: catalogImageUrlOrNull(web.imageUrl),
        suggested_metadata: identityMeta({
          source: "web-identifier",
          method: web.method,
          identifier: code,
          category: web.category,
          entity_type: web.entityType,
          ...(web.series ? { series: web.series } : {}),
          ...(parsePackSize(web.name) ? { pack_size: parsePackSize(web.name) } : {}),
        }) as never,
        ai_confidence: String(web.confidence),
        ai_notes: web.evidence,
        ai_suggested_at: new Date(),
        updated_at: new Date(),
      })
      .where("id", "=", itemId)
      .execute();
    if (web.imageUrl) void downloadCatalogImage({ db, orgId: opts.orgId, itemId }, web.imageUrl).catch(() => {});
    return "named";
  }
  await db
    .updateTable("core_scan_inbox_items")
    .set({
      ai_notes: web
        ? `Nothing on the web agrees on what ${code} is. Kept the name you typed.`
        : `Nothing on the web for ${code}. Kept the name you typed.`,
      suggested_metadata: mergeMeta({
        identifier: code,
        ...(web ? { held_name: web.name, held_reason: "uncorroborated" } : {}),
      }) as never,
      ai_suggested_at: new Date(),
      updated_at: new Date(),
    })
    .where("id", "=", itemId)
    .execute();
  return "held";
}
