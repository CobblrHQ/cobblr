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

import net from "node:net";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { lookupBarcode, type BarcodeHit } from "./barcode-lookup.js";
import { resolveBarcodeViaWebSearch } from "./barcode-websearch.js";
import type { CoreScanDB } from "../db.js";

// Cross-tenant barcode cache namespace + value shape. A UPC means the same
// product for every workspace, so we resolve each ONCE for the whole host
// (critical on a shared-egress-IP public deploy where the upcitemdb free-tier
// quota is shared across all tenants). A genuine MISS is cached with a TTL so a
// product later added to the catalog gets re-checked; a HIT never expires.
const BARCODE_NS = "barcode";
const GLOBAL_MISS_TTL_SEC = 30 * 24 * 60 * 60; // 30 days
interface BarcodeCacheValue {
  found: boolean;
  source: string;
  title: string | null;
  brand: string | null;
  model: string | null;
  description: string | null;
  category: string | null;
  image_url: string | null;
  raw: Record<string, unknown>;
}

// The catalog-image upload re-uses the caller's bearer token, so it MUST
// target our own API — never a caller-influenced base URL, or the token
// leaks. enrich runs in the api process, so localhost is correct.
const INTERNAL_API = `http://127.0.0.1:${process.env.API_PORT ?? 4000}`;

// SSRF guard for the externally-sourced catalog image_url: block
// non-http(s) + internal targets (loopback/private/link-local incl.
// cloud metadata). Hostname-based; not DNS-rebind-proof (follow-up).
function isPrivateIp(ip: string): boolean {
  if (ip === "::1" || ip.startsWith("fe80:") || ip.startsWith("fc") || ip.startsWith("fd")) return true;
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return false;
  const a = p[0]!, b = p[1]!;
  return (
    a === 127 || a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    a === 0
  );
}
function assertSafeOutboundUrl(raw: string): void {
  const u = new URL(raw);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("blocked non-http(s) URL");
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) throw new Error("blocked internal host");
  if (net.isIP(host) && isPrivateIp(host)) throw new Error("blocked private address");
}

interface EnrichContext {
  /** Tenant DB for this workspace. */
  db: Kysely<CoreScanDB>;
  /** Org UUID — for the metered core-ai web-search identify call. */
  orgId: string;
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
  /** Skip BOTH cache tiers (tenant + cross-tenant shared) and re-resolve
   *  live. Rerun-AI sets this: deleting only the tenant row left the
   *  shared cache to answer with the stale pre-resolver result, so the
   *  box resolver was never asked again. The fresh result re-puts both
   *  caches below, healing the stale entry for every tenant. */
  force?: boolean;
}

export async function enrichBarcodeItem(ctx: EnrichContext): Promise<void> {
  // 1a. Per-tenant cache first (local, fastest). force → skip straight to
  // a live lookup (rerun must actually re-ask the providers).
  const tenantRow = ctx.force
    ? undefined
    : await ctx.db
        .selectFrom("core_scan_barcode_cache")
        .selectAll()
        .where("upc", "=", ctx.upc)
        .executeTakeFirst();

  let cacheVal: BarcodeCacheValue | null = tenantRow
    ? {
        found: tenantRow.found,
        source: tenantRow.source,
        title: tenantRow.title,
        brand: tenantRow.brand,
        model: tenantRow.model,
        description: tenantRow.description,
        category: tenantRow.category,
        image_url: tenantRow.image_url,
        raw: tenantRow.raw as Record<string, unknown>,
      }
    : null;

  // 1b. Cross-tenant cache — if THIS tenant hasn't seen the UPC but another
  // tenant already resolved it, reuse that (zero API quota) and mirror it down
  // into the tenant cache so future local scans skip the meta round-trip.
  if (!cacheVal && !ctx.force) {
    const global = await platform()
      .sharedCache.get<BarcodeCacheValue>(BARCODE_NS, ctx.upc)
      .catch(() => null);
    if (global) {
      cacheVal = global;
      await writeTenantCache(ctx, global).catch(() => {});
    }
  }

  let hit: BarcodeHit | null = null;
  let rateLimited = false;
  if (cacheVal) {
    if (!cacheVal.found) {
      // Cached definitive miss — nothing to do.
      await ctx.db
        .updateTable("core_scan_inbox_items")
        .set({ ai_suggested_at: new Date(), updated_at: new Date() })
        .where("id", "=", ctx.itemId)
        .execute();
      return;
    }
    hit = {
      source: cacheVal.source as BarcodeHit["source"],
      title: cacheVal.title ?? "",
      brand: cacheVal.brand,
      model: cacheVal.model,
      description: cacheVal.description,
      category: cacheVal.category,
      image_url: cacheVal.image_url,
      raw: cacheVal.raw,
    };
  } else {
    const result = await lookupBarcode(ctx.upc);
    if (result.outcome === "hit") hit = result.hit;
    if (result.outcome === "rate_limited") rateLimited = true;
    // Cache a HIT or a DEFINITIVE MISS — both durable — to BOTH the tenant and
    // the cross-tenant cache. CRUCIALLY do NOT cache a `rate_limited` outcome:
    // the product is unresolved, not absent, so a later scan must retry. (That
    // mis-cache was the bug that made real products — yarn — permanently
    // un-findable once the shared upcitemdb trial throttled us.)
    if (result.outcome !== "rate_limited") {
      const value: BarcodeCacheValue = {
        found: !!hit,
        source: hit?.source ?? "miss",
        title: hit?.title ?? null,
        brand: hit?.brand ?? null,
        model: hit?.model ?? null,
        description: hit?.description ?? null,
        category: hit?.category ?? null,
        image_url: hit?.image_url ?? null,
        raw: hit?.raw ?? {},
      };
      await writeTenantCache(ctx, value).catch((err) =>
        console.error("[core-scan] tenant cache write failed:", (err as Error).message),
      );
      // A HIT is stable → no expiry; a MISS gets a TTL so a product later added
      // to the catalog is re-checked instead of being a permanent global "no".
      await platform()
        .sharedCache.put(BARCODE_NS, ctx.upc, value, value.found ? undefined : GLOBAL_MISS_TTL_SEC)
        .catch((err) => console.error("[core-scan] shared cache write failed:", (err as Error).message));
    }
  }

  if (!hit) {
    // Catalog DBs have nothing — fall back to web search (what a person
    // does: search the UPC, read the name off the agreeing results).
    const web = await resolveBarcodeViaWebSearch(ctx.orgId, ctx.upc).catch(() => null);
    if (web) {
      await ctx.db
        .updateTable("core_scan_inbox_items")
        .set({
          suggested_name: web.name,
          suggested_manufacturer: web.brand,
          suggested_sku: web.sku,
          catalog_image_url: web.imageUrl,
          suggested_metadata: sql`${JSON.stringify({
            source: "web-search",
            method: web.method,
            category: web.category,
            entity_type: web.entityType,
          })}::jsonb` as never,
          ai_confidence: String(web.confidence),
          ai_notes: web.evidence,
          ai_suggested_at: new Date(),
          updated_at: new Date(),
        })
        .where("id", "=", ctx.itemId)
        .execute();
      // Promote both caches to the web-search resolution. Use an upsert (not a
      // bare UPDATE) because on a rate-limited path no tenant row exists yet.
      // Cache the LLM resolution cross-tenant too (with a TTL) so the next
      // workspace to scan this UPC reuses it instead of paying for another
      // web-search — but it can still be superseded by a real catalog hit later.
      const webValue: BarcodeCacheValue = {
        found: true,
        source: "web-search",
        title: web.name,
        brand: web.brand,
        model: web.sku,
        description: null,
        category: web.category,
        image_url: web.imageUrl,
        raw: {},
      };
      await writeTenantCache(ctx, webValue).catch(() => {});
      await platform()
        .sharedCache.put(BARCODE_NS, ctx.upc, webValue, GLOBAL_MISS_TTL_SEC)
        .catch(() => {});
      if (web.imageUrl) await downloadCatalogImage(ctx, web.imageUrl);
      return;
    }
    // Nothing resolved. Distinguish a genuine miss (catalogs + web search all
    // came up empty — fill in manually) from a transient rate-limit (the
    // catalog was throttled and web search didn't save us — a re-scan should
    // retry, and we deliberately left the cache untouched so it can).
    await ctx.db
      .updateTable("core_scan_inbox_items")
      .set({
        ai_notes: rateLimited
          ? "The barcode service is briefly rate-limited — re-scan in a moment to retry the lookup."
          : "No catalog hit for this barcode, and web search turned up nothing. Fill in manually.",
        // On a rate-limit, leave ai_suggested_at NULL so the autonomous sort can
        // pick the item back up and retry rather than treating it as finished.
        ...(rateLimited ? {} : { ai_suggested_at: new Date() }),
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
  if (hit.image_url) await downloadCatalogImage(ctx, hit.image_url);
}

/** Upsert the per-tenant barcode cache row for this UPC. Upsert (not
 *  insert-or-nothing) so mirroring a cross-tenant value or promoting a
 *  web-search resolution updates an existing row instead of being dropped. */
async function writeTenantCache(ctx: EnrichContext, v: BarcodeCacheValue): Promise<void> {
  const fields = {
    found: v.found,
    source: v.source,
    title: v.title,
    brand: v.brand,
    model: v.model,
    description: v.description,
    category: v.category,
    image_url: v.image_url,
    raw: sql`${JSON.stringify(v.raw ?? {})}::jsonb` as never,
  };
  await ctx.db
    .insertInto("core_scan_barcode_cache")
    .values({ upc: ctx.upc, ...fields })
    .onConflict((c) => c.column("upc").doUpdateSet(fields))
    .execute();
}

/** Best-effort: pull an externally-sourced catalog/web-search image into
 *  core-files and stamp catalog_image_file_id on the inbox row. Network
 *  failures aren't fatal — the URL is already on the row for the UI to
 *  fetch directly. SSRF-guarded + size/time-bounded; uses the caller's
 *  bearer against our own API so the upload runs through normal auth. */
/** Download an external image into core-files and stamp it as the item's
 *  catalog image. Exported for the photo-options picker (set-as-catalog). */
export async function downloadCatalogImage(
  ctx: Pick<EnrichContext, "db" | "orgSlug" | "bearer" | "itemId">,
  imageUrl: string,
): Promise<void> {
  try {
    assertSafeOutboundUrl(imageUrl);
    const dlRes = await fetch(imageUrl, {
      headers: { "user-agent": "cobblr-core-scan/0.1" },
      signal: AbortSignal.timeout(8_000),
    });
    const len = Number(dlRes.headers.get("content-length") ?? 0);
    if (dlRes.ok && len <= 10 * 1024 * 1024) {
      const blob = await dlRes.blob();
      const fd = new FormData();
      const filename = imageUrl.split("/").pop() ?? "catalog.jpg";
      fd.append("file", blob, filename);
      // INTERNAL_API, not ctx.baseUrl: this call carries the bearer
      // token, so it must never target a caller-influenced URL.
      const upRes = await fetch(
        `${INTERNAL_API}/api/v1/orgs/${ctx.orgSlug}/modules/core-files/files`,
        { method: "POST", headers: { Authorization: `Bearer ${ctx.bearer}` }, body: fd },
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
    console.error("[core-scan] catalog image download failed:", (err as Error).message);
  }
}
