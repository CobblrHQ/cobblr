// platform.sharedCache — a cross-tenant key/value cache in cobblr_meta.
//
// For data that's identical for every workspace and NOT tenant-private. The
// motivating case: barcode → product lookups. On a multi-tenant host all scans
// leave from one egress IP and share one rate-limited free-tier quota, so
// resolving the same UPC per-tenant burns the quota fast. This makes a UPC
// resolve ONCE for the whole host. The cache stores only the public result
// (UPC → product), never who scanned it, so it's privacy-safe to share.

import { sql } from "kysely";
import { meta } from "../db/meta.js";

export async function get<T = unknown>(namespace: string, key: string): Promise<T | null> {
  const row = await meta
    .selectFrom("shared_cache")
    .select(["value", "expires_at"])
    .where("namespace", "=", namespace)
    .where("key", "=", key)
    .executeTakeFirst();
  if (!row) return null;
  // Lazy expiry — an expired row reads as a miss (and gets overwritten on the
  // next put). A periodic sweep of the partial index can reclaim space later.
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) return null;
  return row.value as T;
}

export async function put(
  namespace: string,
  key: string,
  value: unknown,
  ttlSeconds?: number,
): Promise<void> {
  const expires_at = ttlSeconds && ttlSeconds > 0 ? new Date(Date.now() + ttlSeconds * 1000) : null;
  await meta
    .insertInto("shared_cache")
    .values({
      namespace,
      key,
      value: sql`${JSON.stringify(value ?? null)}::jsonb` as never,
      expires_at,
      updated_at: new Date(),
    })
    .onConflict((c) =>
      c.columns(["namespace", "key"]).doUpdateSet({
        value: sql`${JSON.stringify(value ?? null)}::jsonb` as never,
        expires_at,
        updated_at: new Date(),
      }),
    )
    .execute();
}

/**
 * Forget a key.
 *
 * The cache had no eviction, which is a real gap for a store shared across every
 * workspace: when an entry turned out to be WRONG, the only moves were to
 * overwrite it with another guess or leave it poisoning everyone. Eviction is the
 * honest third option — "we no longer believe this" — so the next lookup takes a
 * fresh look instead of re-serving a disproved answer.
 */
export async function del(namespace: string, key: string): Promise<void> {
  await meta
    .deleteFrom("shared_cache")
    .where("namespace", "=", namespace)
    .where("key", "=", key)
    .execute();
}
