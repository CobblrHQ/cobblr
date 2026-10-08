import type { BarcodeLookup } from "@cobblr/platform-contract/barcode-form";
import { catalogAnswerForCode } from "./catalog-answer.js";
import { resolveBarcodeViaWebSearch } from "./barcode-websearch.js";
import { findTracked } from "./entity-match.js";
import { matchQuery } from "./tracked-stamp.js";

export async function barcodeFormLookup(orgId: string, code: string, userId?: string | null): Promise<BarcodeLookup> {
  const existing = (await findTracked(orgId, matchQuery({ barcode_text: code, suggested_name: null, suggested_manufacturer: null }, null, null))).barcode_matches;
  const answer = await catalogAnswerForCode(code, orgId);
  let hit = answer.hit;
  if (!hit && !answer.rateLimited) {
    const web = await resolveBarcodeViaWebSearch(orgId, code, null, userId);
    if (web?.corroborated) hit = { source: "web", title: web.name, brand: web.brand, model: web.sku, description: null, category: web.category, image_url: web.imageUrl, raw: {} };
  }
  return {
    code,
    outcome: hit ? "hit" : answer.rateLimited ? "unavailable" : "miss",
    fields: hit ? { ...hit.fields, title: hit.title, brand: hit.brand, manufacturer: hit.brand, model: hit.model, category: hit.category, image_url: hit.image_url } : {},
    existing: existing.map(({ kind, id, title, detail_url }) => ({ kind, id, title, detail_url })),
  };
}
