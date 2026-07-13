// The identifier-decoder registry's tenant cache (core_scan_decode_cache),
// shared by BOTH callers: the POST /decode endpoint (typed VIN on the form) and
// the scan-intake enrichment (a scanned door-jamb VIN). Extracted here so the
// two paths cache identically — one shape, one discipline, no drift.
//
// Discipline (mirrors barcode-lookup.ts EXACTLY): a decoded identifier → fields
// mapping is effectively immutable, so a `hit`/`partial` is cached forever
// (expires_at null) and a durable `miss` gets a 30-day TTL, but an `unavailable`
// (provider timeout/outage) is NEVER written — a throttle is not a durable miss,
// so the next scan retries. See services/identifier-registry.ts +
// docs/design-decisions/vin-decode.md §6.

import { sql, type Kysely } from "kysely";
import type { DecodeResult } from "./identifier-registry.js";
import type { CoreScanDB } from "../db.js";

// A bad identifier decodes to nothing today and (barring a provider backfill)
// tomorrow too, so re-asking wastes quota. 30 days matches the barcode-cache.
export const DECODE_MISS_TTL_DAYS = 30;

/** Normalize a code to its cache key: trimmed + uppercased, so "1hg…" and
 *  "1HG…" share one row and a given identifier hits the provider at most once
 *  (VIN decoders uppercase internally; the key stays aligned with matches()). */
export function decodeCacheKey(code: string): string {
  return code.trim().toUpperCase();
}

/** Read a non-expired cache row for (decoder, code), or null. A durable miss
 *  past its TTL reads as absent so it re-resolves. */
export async function readDecodeCache(
  db: Kysely<CoreScanDB>,
  decoderId: string,
  code: string,
): Promise<DecodeResult | null> {
  const row = await db
    .selectFrom("core_scan_decode_cache")
    .selectAll()
    .where("decoder_id", "=", decoderId)
    .where("code", "=", code)
    .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", sql<Date>`now()`)]))
    .executeTakeFirst();
  if (!row) return null;
  return {
    outcome: row.outcome as DecodeResult["outcome"],
    fields: (row.fields ?? {}) as Record<string, string | number>,
    provenance: row.provenance,
    note: row.note ?? undefined,
    raw: row.raw ?? undefined,
  };
}

/** Upsert a decode result. NEVER caches `unavailable`. A `miss` gets a TTL;
 *  `hit`/`partial` never expire (the mapping is immutable). */
export async function writeDecodeCache(
  db: Kysely<CoreScanDB>,
  decoderId: string,
  code: string,
  result: DecodeResult,
): Promise<void> {
  if (result.outcome === "unavailable") return;
  const expires =
    result.outcome === "miss"
      ? sql<Date>`now() + (${DECODE_MISS_TTL_DAYS} || ' days')::interval`
      : null;
  const values = {
    outcome: result.outcome,
    fields: sql`${JSON.stringify(result.fields)}::jsonb`,
    provenance: result.provenance,
    note: result.note ?? null,
    raw: result.raw ? sql`${JSON.stringify(result.raw)}::jsonb` : null,
    fetched_at: sql`now()`,
    expires_at: expires,
  };
  await db
    .insertInto("core_scan_decode_cache")
    .values({ decoder_id: decoderId, code, ...values } as never)
    .onConflict((oc) => oc.columns(["decoder_id", "code"]).doUpdateSet(values as never))
    .execute();
}
