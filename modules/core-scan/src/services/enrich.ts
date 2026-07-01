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
import { reportBarcodeCorrection } from "./barcode-corrections.js";
import { classifyScanCode, resolveIsbn, resolveAsin } from "./scan-router.js";
import { crossCheckScanPhoto, identifyImage, parsePackSize, refreshCatalogImageByName } from "./enrich-photo.js";
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

// Cached-hit freshness (stale-while-revalidate): a cache entry older than this
// is SERVED (instant scan) but re-checked against the box resolver in the
// background, so a BIdb correction made anywhere propagates to every instance
// within a day of the next scan — instead of a stale shared-cache entry
// outliving the fix forever (the "96 Packs survived its own correction" hole).
// The stamp rides INSIDE raw (__fetched_at) so it survives both cache layers
// verbatim; entries from before the stamp existed count as stale.
const CACHE_REVALIDATE_MS = 24 * 60 * 60 * 1000;

function stampFetchedAt(raw: Record<string, unknown> | null | undefined): Record<string, unknown> {
  return { ...(raw ?? {}), __fetched_at: Date.now() };
}

/** Detached: re-consult the box resolver for a stale cached hit; on a changed
 *  answer, refresh both caches and — when the item still shows the stale name —
 *  the item itself (the same lazy-fill pattern the enrich overrun uses). */
async function revalidateStaleHit(ctx: EnrichContext, staleTitle: string | null): Promise<void> {
  const result = await lookupBarcode(ctx.upc);
  if (result.outcome !== "hit" || !result.hit) return; // keep serving the old value
  const fresh = result.hit;
  const value: BarcodeCacheValue = {
    found: true,
    source: fresh.source,
    title: fresh.title ?? null,
    brand: fresh.brand ?? null,
    model: fresh.model ?? null,
    description: fresh.description ?? null,
    category: fresh.category ?? null,
    image_url: fresh.image_url ?? null,
    raw: stampFetchedAt(fresh.raw),
  };
  await writeTenantCache(ctx, value).catch(() => {});
  await platform().sharedCache.put(BARCODE_NS, ctx.upc, value).catch(() => {});
  const freshTitle = withBrandPrefix(fresh.title || null, fresh.brand);
  if (!freshTitle || !staleTitle || norm2(freshTitle) === norm2(staleTitle)) return;
  // The resolver's answer CHANGED (a correction landed). Fix the item too —
  // only while it's still pending and still wearing the stale name.
  const cur = await ctx.db
    .selectFrom("core_scan_inbox_items")
    .select(["status", "suggested_name"])
    .where("id", "=", ctx.itemId)
    .executeTakeFirst();
  if (!cur || cur.status !== "pending" || norm2(cur.suggested_name ?? "") !== norm2(staleTitle)) return;
  await ctx.db
    .updateTable("core_scan_inbox_items")
    .set({
      suggested_name: freshTitle,
      ...(fresh.brand ? { suggested_manufacturer: fresh.brand } : {}),
      ...(fresh.image_url ? { catalog_image_url: fresh.image_url } : {}),
      ai_notes: `Identified via ${SOURCE_LABEL[fresh.source] ?? fresh.source} (refreshed — the shared entry was updated).`,
      updated_at: new Date(),
    })
    .where("id", "=", ctx.itemId)
    .execute();
}

const norm2 = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

// Human-readable provider names for the "Resolved via …" provenance note (the
// raw tier ids — openfoodfacts, go-upc — aren't friendly to a user).
const SOURCE_LABEL: Record<string, string> = {
  "go-upc": "go-upc",
  upcitemdb: "UPCitemdb",
  openfoodfacts: "Open Food Facts",
  openproductsfacts: "Open Products Facts",
  openbeautyfacts: "Open Beauty Facts",
  openpetfoodfacts: "Open Pet Food Facts",
  openlibrary: "Open Library",
  musicbrainz: "MusicBrainz",
  "web-search": "a web search",
};
const sourceLabel = (s: string): string => SOURCE_LABEL[s] ?? s;

// Provenance string for the inbox note. When the shared box resolver served the
// result from the Barcode Intelligence DB (its cache or the OFF mirror), it
// stamps raw.resolver.cache==="hit" — that's an instant DB hit, not a live
// provider fetch, so we prefix "BIdb / " to make the source honest.
function provenanceLabel(hit: BarcodeHit): string {
  const served = (hit.raw as { resolver?: { cache?: string } })?.resolver?.cache === "hit";
  return (served ? "BIdb / " : "") + sourceLabel(hit.source);
}

/** Standardize a product name to LEAD WITH ITS BRAND when it doesn't already —
 *  a sparse source name like "Black Label No.7" (brand "Jack Daniel's") reads
 *  much better as "Jack Daniel's Black Label No.7". Skips when the brand is
 *  already present (full string, or all its significant words appear) so it never
 *  doubles up ("Jack Daniel's Jack Daniel's …"). Brand-less / nameless → unchanged. */
function withBrandPrefix(name: string | null, brand: string | null): string | null {
  const n = (name ?? "").trim();
  const b = (brand ?? "").trim();
  if (!n || !b) return name;
  const nl = n.toLowerCase();
  if (nl.includes(b.toLowerCase())) return n;
  const bw = b.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  if (bw.length > 0 && bw.every((w) => nl.includes(w))) return n;
  return `${b} ${n}`;
}

// Last resort when the barcode + web search find nothing: if the scan carried a
// photo, identify the item FROM the photo (vision) and use that as the name —
// turning the AI's clear "I can see what this is" into an actual title instead of
// leaving a blank "name required" row. Returns true when it named the item.
async function nameFromPhoto(ctx: EnrichContext): Promise<boolean> {
  const row = await ctx.db
    .selectFrom("core_scan_inbox_items")
    .select(["image_file_id"])
    .where("id", "=", ctx.itemId)
    .executeTakeFirst();
  if (!row?.image_file_id) return false; // a hardware-wedge scan with no photo
  const file =
    (await platform().files.read(ctx.orgId, row.image_file_id, "medium")) ??
    (await platform().files.read(ctx.orgId, row.image_file_id, "original"));
  if (!file) return false;
  const identity = await identifyImage(
    ctx.orgId,
    Buffer.from(file.bytes).toString("base64"),
    file.mimeType,
    ctx.itemId,
  ).catch(() => null);
  if (!identity?.name) return false;
  // The vision call can outlive the request's tenant pool — re-acquire.
  const db = (await platform().tenants.getDb(ctx.orgId)) as unknown as typeof ctx.db;
  await db
    .updateTable("core_scan_inbox_items")
    .set({
      suggested_name: identity.name,
      suggested_manufacturer: identity.brand,
      suggested_metadata: sql`${JSON.stringify({
        source: "photo",
        category: identity.category,
        entity_type: identity.entityType,
      })}::jsonb` as never,
      ai_confidence: String(Math.min(identity.confidence, 0.7)),
      ai_notes: "No catalog or web hit — named from your photo.",
      ai_suggested_at: new Date(),
      updated_at: new Date(),
    })
    .where("id", "=", ctx.itemId)
    .execute();
  return true;
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
export function assertSafeOutboundUrl(raw: string): void {
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
  /** The user pressed "This is wrong" — re-resolve across ALL sources and treat
   *  the result as AUTHORITATIVE: run the web identify unconditionally (not only
   *  when the provider name looks thin) and adopt a confident web result even if
   *  it isn't strictly "fuller" than the flagged one, then write the correction
   *  back to BIdb. Distrust-the-current-answer mode. */
  wrong?: boolean;
  /** The user pressed "Right product, but needs detail" — the IDENTITY is fine
   *  but the listing is thin (a bare "stratosphere gin"). Run the web identify
   *  unconditionally and accept a fuller name for the SAME product (keep the
   *  same-product guard, drop the must-add-hard-spec requirement) — fill in the
   *  proper name / spec / brand without changing what it is. */
  enrich?: boolean;
  /** The user's "what's wrong / what is it" note — folded into the web identify
   *  so a correction like "it's Maker's Mark" steers the re-resolution. */
  hint?: string;
}

export async function enrichBarcodeItem(ctx: EnrichContext): Promise<void> {
  // If the user hand-picked a catalog image, NO enrichment path may overwrite it —
  // it's their explicit choice and must survive a re-run/hint correction. The write
  // paths below clobber catalog_image_url AND rewrite suggested_metadata (dropping
  // the `catalog_image_user_set` lock), so we hold the refs up front and re-assert
  // them (+ re-stamp the lock) after each path. `refreshCatalogImageByName` is the
  // matching guard on the detached enrichThinHit tail.
  const lockRow = await ctx.db
    .selectFrom("core_scan_inbox_items")
    .select(["catalog_image_url", "catalog_image_file_id", "suggested_metadata"])
    .where("id", "=", ctx.itemId)
    .executeTakeFirst();
  const lockedImg = (lockRow?.suggested_metadata as { catalog_image_user_set?: boolean } | null)
    ?.catalog_image_user_set
    ? { url: lockRow!.catalog_image_url, file_id: lockRow!.catalog_image_file_id }
    : null;
  const reassertLockedImage = async (): Promise<void> => {
    if (!lockedImg) return;
    await ctx.db
      .updateTable("core_scan_inbox_items")
      .set({
        catalog_image_url: lockedImg.url,
        catalog_image_file_id: lockedImg.file_id,
        suggested_metadata: sql`coalesce(suggested_metadata, '{}'::jsonb) || '{"catalog_image_user_set":true}'::jsonb` as never,
        updated_at: new Date(),
      })
      .where("id", "=", ctx.itemId)
      .execute();
  };

  // 0. Vendor scan-URL fast path. A scanned QR is often a maker's product
  // URL (a Polar spool → 3dqr.co/?i=…); a registered resolver fetches the
  // real product page instead of letting the generic barcode/web-search path
  // find the maker's marketing page. Nothing vendor-specific lives here — the
  // kernel just asks the registry (the maker-scan connector registers the
  // vendors). A miss falls straight through to the barcode path below.
  // `force` (a re-run) rides through so the vendor resolver bypasses its own
  // cache and re-fetches — otherwise a stale cached resolution survives a re-run.
  const vendor = await platform().scan.resolveUrl(ctx.upc, { force: ctx.force }).catch(() => null);
  if (vendor) {
    await ctx.db
      .updateTable("core_scan_inbox_items")
      .set({
        suggested_name: vendor.name,
        suggested_manufacturer: vendor.brand,
        catalog_image_url: vendor.imageUrl ?? null,
        // `fields` ride in suggested_metadata so the commit can land them on
        // the created entity's metadata (size / batch_code for a spool, …).
        suggested_metadata: sql`${JSON.stringify({
          source: vendor.source,
          category: vendor.category,
          entity_type: vendor.entityType,
          fields: vendor.fields,
        })}::jsonb` as never,
        ai_confidence: "0.9",
        // User-facing note: name the maker/brand, never the internal resolver
        // id (e.g. "polar-pfil") — that's a private routing detail, not for users.
        ai_notes: vendor.brand
          ? `Matched from the ${vendor.brand} product page.`
          : "Matched from the maker's product page.",
        ai_suggested_at: new Date(),
        updated_at: new Date(),
      })
      .where("id", "=", ctx.itemId)
      .execute();
    if (vendor.imageUrl) await downloadCatalogImage(ctx, vendor.imageUrl).catch(() => {});
    await reassertLockedImage();
    return;
  }

  // 0b. Route by code TYPE. Only a real product barcode (UPC/EAN) belongs in the
  // go-upc/upcitemdb chain; an Amazon FNSKU/ASIN, an ISBN, or a URL would just
  // waste it — and a throttled budget would then falsely mark them "rate-limited"
  // and loop forever instead of giving up. See scan-router.
  const codeClass = classifyScanCode(ctx.upc);
  if (codeClass.type === "fnsku") {
    // An Amazon fulfillment label identifies a unit only inside Amazon's
    // warehouse — no public database can resolve it. Go straight to manual
    // naming, and stamp ai_suggested_at so it's FINAL (not stuck in the
    // rate-limit retry loop) and the matchmaker stops promising a re-route.
    await ctx.db
      .updateTable("core_scan_inbox_items")
      .set({
        ai_confidence: "0",
        ai_notes:
          "Amazon fulfillment label (FNSKU) — it identifies a unit only inside Amazon's warehouse, so it can't be looked up. Name it manually, or scan the product's own UPC barcode.",
        ai_suggested_at: new Date(),
        updated_at: new Date(),
      })
      .where("id", "=", ctx.itemId)
      .execute();
    return;
  }

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
    // Stale-while-revalidate: serve instantly, re-check a day-old (or legacy
    // unstamped) entry in the background so corrections propagate everywhere.
    const fetchedAt = Number((cacheVal.raw as { __fetched_at?: number } | null)?.__fetched_at ?? 0);
    if (!fetchedAt || Date.now() - fetchedAt > CACHE_REVALIDATE_MS) {
      void revalidateStaleHit(ctx, withBrandPrefix(cacheVal.title, cacheVal.brand)).catch(() => {});
    }
  } else if (
    codeClass.type === "upc" ||
    (codeClass.type === "isbn" && /^(978|979)[0-9]{10}$/.test(ctx.upc.replace(/\D/g, "")))
  ) {
    // UPC/EAN — OR a scanned book's ISBN-13, which IS an EAN-13. Both resolve
    // through the box resolver chain, so books now hit the local Open Library
    // mirror (free, instant, offline) and CDs/vinyl hit the MusicBrainz mirror,
    // instead of leaning on the live APIs. A miss on an ISBN still falls back to
    // the live Open Library API below (a brand-new book not yet in the mirror).
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
        raw: stampFetchedAt(hit?.raw),
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
    // ISBN-13 not in any resolver tier (incl. the OL mirror) → the live Open
    // Library API as a last resort before web search.
    if (codeClass.type === "isbn" && !hit && !rateLimited) {
      hit = await resolveIsbn(codeClass.code).catch(() => null);
    }
  } else if (codeClass.type === "isbn") {
    // An ISBN-10 (manual entry — a scanned book is the ISBN-13 EAN handled above).
    // The live Open Library API; a miss falls through to web search.
    hit = await resolveIsbn(codeClass.code).catch(() => null);
  } else if (codeClass.type === "asin") {
    // A real Amazon ASIN → best-effort product-page title. Amazon often blocks
    // automation, so a miss falls through to web search (which finds the listing).
    hit = await resolveAsin(codeClass.code).catch(() => null);
  }
  // url / unknown → no dedicated lookup; hit stays null → web search below.

  if (!hit) {
    // Catalog DBs have nothing — fall back to web search (what a person
    // does: search the UPC, read the name off the agreeing results).
    const web = await resolveBarcodeViaWebSearch(ctx.orgId, ctx.upc, ctx.hint).catch(() => null);
    // A junk "name" ("Unknown Item" / "XXXXXXXX") means the web couldn't identify
    // it either — DON'T accept it as a result. Fall through to the photo/manual
    // path with no name, so it never gets shown as valid or image-searched.
    if (web && !isJunkName(web.name)) {
      await ctx.db
        .updateTable("core_scan_inbox_items")
        .set({
          suggested_name: withBrandPrefix(web.name, web.brand),
          suggested_manufacturer: web.brand,
          suggested_sku: web.sku,
          catalog_image_url: web.imageUrl,
          suggested_metadata: sql`${JSON.stringify({
            source: "web-search",
            method: web.method,
            category: web.category,
            entity_type: web.entityType,
            ...(parsePackSize(web.name) ? { pack_size: parsePackSize(web.name) } : {}),
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
        raw: stampFetchedAt({}),
      };
      await writeTenantCache(ctx, webValue).catch(() => {});
      await platform()
        .sharedCache.put(BARCODE_NS, ctx.upc, webValue, GLOBAL_MISS_TTL_SEC)
        .catch(() => {});
      if (web.imageUrl) await downloadCatalogImage(ctx, web.imageUrl);
      // A web-search title is the weakest source (a UPC search can surface a
      // SPURIOUS listing — e.g. a J-Link probe coming back as a power supply). If
      // the user gave us a photo, let it arbitrate: the cross-check replaces the
      // name outright when the photo unambiguously shows a different product.
      void crossCheckScanPhoto(ctx.orgId, ctx.itemId, web.name).catch((e) =>
        console.error("[core-scan] web-search cross-check threw:", (e as Error).message),
      );
      await reassertLockedImage();
      return;
    }
    // Nothing from the barcode or web. Before giving up to manual entry, if the
    // user gave us a photo, NAME it from the photo — the vision read routinely
    // nails what the catalogs missed (a museum-gift souvenir, a foreign-language
    // book edition). Only on a genuine miss, not a transient rate-limit (which
    // should retry the lookup, not burn a vision call).
    if (!rateLimited && (await nameFromPhoto(ctx))) return;
    // Nothing resolved. Distinguish a genuine miss (catalogs + web search all
    // came up empty — fill in manually) from a transient rate-limit (the
    // catalog was throttled and web search didn't save us — a re-scan should
    // retry, and we deliberately left the cache untouched so it can).
    await ctx.db
      .updateTable("core_scan_inbox_items")
      .set({
        ai_notes: rateLimited
          ? "Barcode service is rate-limited — retrying automatically in a moment."
          : "No catalog hit for this barcode, and web search turned up nothing. Fill in manually.",
        // On a rate-limit, leave ai_suggested_at NULL (reads as unfinished) AND
        // tag the row so the client shows a distinct "retrying" state and paces
        // an auto-retry. The lookup wasn't cached, so retrying once the go-upc /
        // upcitemdb gate frees will resolve it — no need to re-scan the item.
        ...(rateLimited
          ? { suggested_metadata: sql`${JSON.stringify({ rate_limited: true })}::jsonb` as never }
          : { ai_suggested_at: new Date() }),
        updated_at: new Date(),
      })
      .where("id", "=", ctx.itemId)
      .execute();
    return;
  }

  // A short barcode (EAN-8 / UPC-E / a store-local or truncated code, < 12
  // digits) is far more collision-prone than a full UPC-A/EAN-13: the global
  // catalogs can return a confidently-wrong product that merely shares the digits
  // (the classic Trader Joe's store-code mismatch — an 8-digit code resolving to
  // an unrelated item). Flag these so the user double-checks instead of trusting
  // blindly, and damp the confidence so nothing auto-commits on a shaky match.
  const lowTrust = codeClass.type === "upc" && ctx.upc.replace(/\D/g, "").length < 12;

  // 2. Stash the catalog image URL on the row immediately; the
  // actual file download happens next and may take a moment.
  // Suggested_metadata carries the source + raw payload so the
  // confirm step has access to the full provider response.
  await ctx.db
    .updateTable("core_scan_inbox_items")
    .set({
      suggested_name: withBrandPrefix(hit.title || null, hit.brand),
      suggested_manufacturer: hit.brand,
      suggested_sku: hit.model,
      catalog_image_url: hit.image_url,
      suggested_metadata: sql`${JSON.stringify({
        source: hit.source,
        category: hit.category,
        description: hit.description,
        raw: hit.raw,
        low_trust: lowTrust || undefined,
        // Multipack read off the title ("WD-40 2 Pack") — carried to the entity.
        ...(parsePackSize(hit.title) ? { pack_size: parsePackSize(hit.title) } : {}),
      })}::jsonb` as never,
      ai_confidence: hit.title ? (lowTrust ? "0.6" : "0.85") : null,
      // Provenance: a box-resolver result that came from the shared Barcode
      // Intelligence DB (cache or OFF mirror) returns resolver.cache==="hit" —
      // it resolved instantly from BIdb, NOT a live provider call. Surface that
      // as "BIdb / go-upc" so an instant hit doesn't read as a live go-upc fetch.
      ai_notes: hit.title
        ? `Identified via ${provenanceLabel(hit)}.${
            lowTrust ? " ⚠ Short barcode — double-check this is the right product." : ""
          }`
        : `Resolved via ${provenanceLabel(hit)}.`,
      ai_suggested_at: new Date(),
      updated_at: new Date(),
    })
    .where("id", "=", ctx.itemId)
    .execute();

  // 3. Download the catalog image into core-files (best-effort).
  if (hit.image_url) await downloadCatalogImage(ctx, hit.image_url);
  // A user-locked catalog image wins over the provider's — restore it (the hit
  // write above clobbered the url + dropped the lock; the download replaced the
  // file). The detached refresh/cross-check below re-read the lock and skip.
  await reassertLockedImage();

  // 3b. On an explicit RE-RUN, the resolver's image can be stale even when the
  // title is right — go-upc corrects titles but keeps the original (wrong)
  // product's photo, so a UPC fixed in the Barcode Intelligence DB resolves to
  // the correct NAME but the WRONG picture (the field "Pinecil" case: ribbon-
  // cable image, Pinecil name). The photo cross-check can't catch it (name now
  // matches the user's photo), so re-search the image by the resolved name and
  // let it override. Force-only (don't churn first-pass images); detached.
  if (ctx.force && hit.title) {
    void refreshCatalogImageByName(ctx.orgId, ctx.itemId, hit.title, hit.brand ?? null).catch((e) =>
      console.error("[core-scan] catalog refresh on re-run failed:", (e as Error).message),
    );
  }

  // 4. Cross-check the resolved name against the user's scan photo (#3d) — catches
  // a confidently-wrong barcode (store-local/reused code → unrelated product) that
  // the catalog lookup can't. Detached + best-effort: the named item is already
  // written; a clear mismatch flags asynchronously. No-op without a scan photo.
  if (hit.title) {
    void crossCheckScanPhoto(ctx.orgId, ctx.itemId, hit.title).catch((e) =>
      console.error("[core-scan] photo cross-check failed:", (e as Error).message),
    );
  }

  // 5. THIN HIT → enrich + feed BIdb. A bare category name ("Bourbon"), usually
  // from a light Open*Facts mirror entry that's technically right but sparse, is a
  // STARTING POINT — not the finished answer. When the name omits the brand (it's
  // a category, not the product), web+AI builds the full title and we write it
  // back to the Barcode Intelligence DB so it SUPERSEDES the thin entry for every
  // future scan, any instance — "enrichen our DB once we process it the first
  // time." Detached + best-effort; resolveBarcodeViaWebSearch is internally
  // AI-gated, and once the write-back lands the next resolve isn't thin → no loop.
  // Thin hit → enrich. ALSO when the user flagged it wrong (re-derive), asked to
  // enrich it (fill in detail), gave a research HINT (a targeted correction like
  // "it's 1 unit, not 96 packs" — re-identify folding the hint in), or the provider
  // title is non-English (re-identify prefers English): run the web identify
  // regardless of thin-ness.
  if (ctx.wrong || ctx.enrich || ctx.hint || isThinHit(hit) || looksNonEnglish(hit.title)) {
    void enrichThinHit(ctx, hit).catch((e) =>
      console.error("[core-scan] thin-hit enrich failed:", (e as Error).message),
    );
  }
}

/** A resolver hit worth enriching: a brand exists but the NAME omits it (a bare
 *  category like "Bourbon"), or a very short name from a light crowdsourced mirror
 *  (Open*Facts). A name that already carries its brand is left alone. */
function isThinHit(hit: BarcodeHit): boolean {
  const title = hit.title?.trim() ?? "";
  if (!title) return false;
  const brand = hit.brand?.trim() ?? "";
  if (brand.length >= 2 && title.toLowerCase().includes(brand.toLowerCase())) return false;
  const words = title.split(/\s+/).filter(Boolean);
  const LIGHT = new Set([
    "openfoodfacts",
    "openproductsfacts",
    "openbeautyfacts",
    "openpetfoodfacts",
    "openlibrary",
    "musicbrainz",
  ]);
  return (brand.length >= 2 && words.length <= 3) || (LIGHT.has(hit.source) && words.length <= 2);
}

/** A name that is NOT a real identification — the web-search LLM's "I give up"
 *  output for a barcode with no usable results: an empty/"Unknown Item" string, a
 *  placeholder run of one character ("XXXXXXXX"), or something too short to be a
 *  product. These must never become the item's name or get image-searched. */
export function isJunkName(name: string | null | undefined): boolean {
  const n = (name ?? "").trim();
  if (!n) return true;
  const lc = n.toLowerCase();
  if (lc === "unknown" || lc === "unknown item" || lc === "unidentified" || lc === "n/a" || lc.startsWith("unknown ")) {
    return true;
  }
  const alnum = n.replace(/[^a-z0-9]/gi, "");
  if (alnum.length < 3) return true; // too short to be a product name
  if (/(.)\1{3,}/i.test(alnum)) return true; // a run of one char ≥4 (placeholder)
  return false;
}

/** A provider sometimes returns a LOCALIZED title (go-upc handed back "Charmin
 *  Papel Higiénico Ultra Soft" for a US item). Treat a non-English-looking title
 *  as worth a web re-identify, which prefers English. Heuristic: accented Latin
 *  letters (Spanish/French/Portuguese/German/…) or any non-Latin script. An
 *  English-market name that legitimately carries an accent ("Nestlé") is safe —
 *  the re-identify just returns the same accented name and nothing changes. */
function looksNonEnglish(s: string | null | undefined): boolean {
  if (!s) return false;
  // Accented Latin letters, skipping × (×) and ÷ (÷).
  if (/[À-ÖØ-öø-ſ]/.test(s)) return true;
  // Any non-Latin script (Greek, Cyrillic, CJK, Arabic, Hebrew, …).
  if (/[Ͱ-῿Ⰰ-퟿豈-﷿ﹰ-﻿＀-￯]/.test(s)) return true;
  return false;
}

/** Web+AI-enrich a thin hit into a full product title, update the row, and feed
 *  the richer result back to BIdb (trusted actor → supersedes the thin entry).
 *  Only upgrades when the web result is genuinely FULLER + about the same product
 *  (shares the head noun) + reasonably confident — never replaces a hit with a
 *  shakier guess. Detached/best-effort. */
async function enrichThinHit(ctx: EnrichContext, hit: BarcodeHit): Promise<void> {
  const thin = hit.title?.trim() ?? "";
  const web = await resolveBarcodeViaWebSearch(ctx.orgId, ctx.upc, ctx.hint).catch(() => null);
  const enriched = web?.name?.trim();
  if (!web || !enriched || web.confidence < 0.5 || isJunkName(enriched)) return;
  // Only upgrade when the web result adds REAL SKU information — the package
  // size/spec (1.75 L / 750 mL / 12 ct / proof / net weight) or the brand — not
  // just more descriptive words. A longer-but-spec-less name ("…Frontier Whiskey"
  // with no size) is fluff and must NOT replace the thin name. The head-noun
  // share keeps it about the same product (not a hallucinated different one).
  const SPEC_RE =
    /\b\d+(?:\.\d+)?\s?(?:ml|cl|l|liter|litre|fl\.?\s?oz|oz|g|kg|mg|lb|ct|pk|pack|count|gal|qt|pt|proof|%)\b/i;
  const brandLc = (web.brand ?? hit.brand ?? "").trim().toLowerCase();
  const addsSpec = SPEC_RE.test(enriched) && !SPEC_RE.test(thin);
  const addsBrand =
    brandLc.length >= 2 && !thin.toLowerCase().includes(brandLc) && enriched.toLowerCase().includes(brandLc);
  const headNoun = thin.toLowerCase().split(/\s+/).find((w) => w.length >= 3) ?? "";
  const sameProduct = headNoun ? enriched.toLowerCase().includes(headNoun) : true;
  // A LOOSER same-product test for ENRICH mode: the user confirmed the product is
  // right, and a spelling fix ("stratosphere" → "Stratusphere") makes the strict
  // head-noun check fail. Accept if the enriched name still shares ANY significant
  // word from the thin one (the category noun "gin" survives a brand respelling),
  // which keeps "gin → gin" but rejects "gin → vodka".
  const thinWords = thin.toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
  const sharesAnyWord = thinWords.length ? thinWords.some((w) => enriched.toLowerCase().includes(w)) : true;
  // Three acceptance bars (the >0.5 confidence gate above always stands):
  //   • WRONG   — the user says the identity is bad: adopt any confident result,
  //               same-product + adds-info gates dropped (it may be a new product).
  //   • ENRICH  — the user says the product is RIGHT but the listing is thin: keep
  //               the same product, accept a fuller name (a more complete name, or
  //               one that adds spec/brand). The identify is anti-fluff (#384), so
  //               "fuller" here means a better name for the same thing.
  //   • default — conservative auto-enrich: same product AND real SKU info only.
  const fuller = enriched.length > thin.length || addsSpec || addsBrand;
  // A non-English provider title replaced by an English one for the same product
  // is always an upgrade, even if it adds no new spec/brand.
  const langUpgrade = looksNonEnglish(thin) && !looksNonEnglish(enriched) && sharesAnyWord;
  // A brandless thin name that's really just a CATEGORY ("Whiskey", "Beer",
  // "Beverages" — an Open*Facts category row, not a product) gains a real brand
  // from the web identify ("Maker's Mark Bourbon Whisky"). That's a valid upgrade
  // even though the specific product shares NO word with the category: "Whiskey"
  // (the OFF spelling) vs Maker's "Whisky", "Beverages" vs anything. The same-word /
  // same-product guards exist to stop gin→vodka, but a *category* legitimately has
  // no word in common with its product — so when the thin name carried no brand and
  // the web result grounds it with a confident brand (UPC-searched, not invented),
  // accept on the brand-grounding alone.
  const thinHadNoBrand = !(hit.brand && hit.brand.trim().length >= 2);
  const categoryUpgrade = thinHadNoBrand && (addsBrand || addsSpec);
  if (ctx.wrong) {
    /* adopt */
  } else if (categoryUpgrade) {
    /* accept: a brandless category grounded with a real brand from the UPC search */
  } else if (ctx.hint) {
    // A targeted research-hint correction ("it's 1 unit, not 96 packs"): the
    // identify already folded the hint in. Accept a confident SAME-PRODUCT result
    // even if it's SHORTER — stripping a wrong "96 Packs" shortens but improves
    // the name, so the `fuller` bar must NOT apply. sharesAnyWord still guards
    // against the identify hallucinating a different product.
    if (!sharesAnyWord) return;
  } else if (ctx.enrich) {
    if (!sharesAnyWord || !fuller) return;
  } else if (langUpgrade) {
    /* accept: English replacement of a localized provider title, same product */
  } else {
    if (!sameProduct || (!addsSpec && !addsBrand)) return;
  }

  await ctx.db
    .updateTable("core_scan_inbox_items")
    .set({
      suggested_name: enriched,
      ...(web.brand ? { suggested_manufacturer: web.brand } : {}),
      suggested_metadata: sql`coalesce(suggested_metadata, '{}'::jsonb) || ${JSON.stringify({
        enriched_from: thin,
        ...(web.category ? { category: web.category } : {}),
      })}::jsonb` as never,
      updated_at: new Date(),
    })
    .where("id", "=", ctx.itemId)
    .execute();

  // The name changed → the image probably should too (a generic "Whiskey" shelf
  // shot shouldn't survive a re-identify to "Maker's Mark"). Re-search by the new
  // name (brand-aware). Detached/best-effort.
  void refreshCatalogImageByName(ctx.orgId, ctx.itemId, enriched, web.brand ?? hit.brand ?? null).catch(() => {});

  // The caches must learn the fix too, or the NEXT scan of this UPC — in this
  // workspace (tenant cache) or any sibling on the instance (shared cache) —
  // resolves to the same wrong title again (why the author had to fix "96 Packs"
  // TWICE). Overwrite both with the corrected value.
  const corrected: BarcodeCacheValue = {
    found: true,
    source: hit.source,
    title: enriched,
    brand: web.brand ?? hit.brand ?? null,
    model: hit.model ?? null,
    description: hit.description ?? null,
    category: web.category ?? hit.category ?? null,
    image_url: hit.image_url ?? null,
    raw: stampFetchedAt({ corrected_from: thin }),
  };
  await writeTenantCache(ctx, corrected).catch(() => {});
  await platform()
    .sharedCache.put(BARCODE_NS, ctx.upc, corrected)
    .catch(() => {});

  // Supersede the thin BIdb/OFF entry for every future scan. Attribution
  // matters: the resolver only VERIFIES (instant-override) a correction that
  // carries an actor — an anonymous one parks in the review queue and never
  // fixes lookups (the `by=? verified=false` hole the golden e2e exposed).
  // The item's creator is the human whose correction this is.
  const creatorRow = await ctx.db
    .selectFrom("core_scan_inbox_items")
    .select("created_by_user_id")
    .where("id", "=", ctx.itemId)
    .executeTakeFirst();
  const creator = creatorRow?.created_by_user_id ?? null;
  void reportBarcodeCorrection({ upc: ctx.upc, field: "title", was: thin, now: enriched, userId: creator }).catch(
    () => {},
  );
  if (web.brand && web.brand !== hit.brand) {
    void reportBarcodeCorrection({
      upc: ctx.upc,
      field: "brand",
      was: hit.brand ?? null,
      now: web.brand,
      userId: creator,
    }).catch(() => {});
  }
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
