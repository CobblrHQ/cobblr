// Enrichment orchestrator. Pulled out of routes so it can be
// re-invoked from /rerun-ai without re-implementing.
//
// Today: barcode-only. Resolves via lookupBarcode(), caches the
// hit/miss in core_scan_barcode_cache, downloads the catalog
// image via the user's bearer token into core-files, and patches
// the inbox row with the suggestion. The whole thing is wrapped
// in a 12s race deadline in the caller (POST /scan) — if the
// resolver is slow we return the bare row immediately and let
// this finish detached.

import type { Kysely } from "kysely";
import { sql } from "kysely";
import { lookupBarcode, type BarcodeHit } from "./barcode-lookup.js";
import type { CoreScanDB } from "../db.js";

interface EnrichContext {
  /** Tenant DB for this workspace. */
  db: Kysely<CoreScanDB>;
  /** Inbox row id. */
  itemId: string;
  /** Org slug — used to build core-files URLs for the catalog
   *  image download. */
  orgSlug: string;
  /** Caller's bearer token — re-used so the core-files attach
   *  call runs through requireAuth + withTenant just like a real
   *  user upload. */
  bearer: string;
  /** Same-host base URL — `${protocol}://${host}` from the
   *  triggering request. */
  baseUrl: string;
  /** UPC to resolve. */
  upc: string;
}

export async function enrichBarcodeItem(ctx: EnrichContext): Promise<void> {
  // 1. Cache lookup first — workspace-scoped UPC cache.
  const cached = await ctx.db
    .selectFrom("core_scan_barcode_cache")
    .selectAll()
    .where("upc", "=", ctx.upc)
    .executeTakeFirst();

  let hit: BarcodeHit | null = null;
  if (cached) {
    if (!cached.found) {
      // Cached definitive miss — nothing to do.
      await ctx.db
        .updateTable("core_scan_inbox_items")
        .set({ ai_suggested_at: new Date(), updated_at: new Date() })
        .where("id", "=", ctx.itemId)
        .execute();
      return;
    }
    hit = {
      source: cached.source as BarcodeHit["source"],
      title: cached.title ?? "",
      brand: cached.brand,
      model: cached.model,
      description: cached.description,
      category: cached.category,
      image_url: cached.image_url,
      raw: cached.raw,
    };
  } else {
    hit = await lookupBarcode(ctx.upc);
    // Cache both hits AND definitive misses. Rate-limit failures
    // (today: surface as null from lookupBarcode) would re-fetch
    // on next attempt — that's the right behaviour. v0.2 will
    // differentiate.
    try {
      await ctx.db
        .insertInto("core_scan_barcode_cache")
        .values({
          upc: ctx.upc,
          found: !!hit,
          source: hit?.source ?? "miss",
          title: hit?.title ?? null,
          brand: hit?.brand ?? null,
          model: hit?.model ?? null,
          description: hit?.description ?? null,
          category: hit?.category ?? null,
          image_url: hit?.image_url ?? null,
          raw: sql`${JSON.stringify(hit?.raw ?? {})}::jsonb` as never,
        })
        .onConflict((c) => c.column("upc").doNothing())
        .execute();
    } catch (err) {
      console.error("[core-scan] cache write failed:", (err as Error).message);
    }
  }

  if (!hit) {
    // Definitive miss — leave the inbox row barcode-only.
    await ctx.db
      .updateTable("core_scan_inbox_items")
      .set({
        ai_notes: "No catalog hit for this barcode. Fill in manually.",
        ai_suggested_at: new Date(),
        updated_at: new Date(),
      })
      .where("id", "=", ctx.itemId)
      .execute();
    return;
  }

  // 2. Stash the catalog image URL on the row immediately; the
  // actual file download happens next and may take a moment.
  // Suggested_metadata carries the source + raw payload so the
  // confirm step has access to the full provider response.
  await ctx.db
    .updateTable("core_scan_inbox_items")
    .set({
      suggested_name: hit.title || null,
      suggested_manufacturer: hit.brand,
      suggested_sku: hit.model,
      catalog_image_url: hit.image_url,
      suggested_metadata: sql`${JSON.stringify({
        source: hit.source,
        category: hit.category,
        description: hit.description,
        raw: hit.raw,
      })}::jsonb` as never,
      ai_confidence: hit.title ? "0.85" : null,
      ai_notes: `Resolved via ${hit.source}.`,
      ai_suggested_at: new Date(),
      updated_at: new Date(),
    })
    .where("id", "=", ctx.itemId)
    .execute();

  // 3. Download the catalog image into core-files (best-effort).
  // Network failures here aren't fatal — the URL is already on
  // the row for the UI to fetch directly if needed.
  if (hit.image_url) {
    try {
      const dlRes = await fetch(hit.image_url, {
        headers: { "user-agent": "cobblr-core-scan/0.1" },
      });
      if (dlRes.ok) {
        const blob = await dlRes.blob();
        const fd = new FormData();
        // Try to keep the source filename for forensics.
        const filename = hit.image_url.split("/").pop() ?? "catalog.jpg";
        fd.append("file", blob, filename);
        const upRes = await fetch(
          `${ctx.baseUrl}/api/v1/orgs/${ctx.orgSlug}/modules/core-files/files`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${ctx.bearer}` },
            body: fd,
          },
        );
        if (upRes.ok) {
          const f = (await upRes.json()) as { id: string };
          await ctx.db
            .updateTable("core_scan_inbox_items")
            .set({ catalog_image_file_id: f.id, updated_at: new Date() })
            .where("id", "=", ctx.itemId)
            .execute();
        }
      }
    } catch (err) {
      console.error(
        "[core-scan] catalog image download failed:",
        (err as Error).message,
      );
    }
  }
}
