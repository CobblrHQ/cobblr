// The fleet's per-connection device list: cached, time-bounded, served
// stale-while-revalidate (fleet.ts reads it for the floor, the camera and the
// telemetry routes).

import type { Kysely } from "kysely";
import type { DigifabDB } from "../db.js";
import type { MachineDriver, RemoteDevice } from "../drivers/types.js";

// F-11 — back-pressure on the per-connection listDevices fan-out. At 50 direct
// connections, a naive Promise.all hits 50 managers every 12s poll, in one
// request, with no cap and no fallback for a slow one. Three guards:
//   1. a short-TTL per-connection cache (a rapid re-poll / second viewer reuses
//      the last fetch instead of re-hitting the manager),
//   2. a per-call timeout so one slow manager can't stall the whole response,
//   3. a concurrency cap so the burst is bounded regardless of fleet size.
// The cache key is the connection id (a globally-unique uuid → tenant-safe);
// device *state* may be up to TTL stale, which is fine on an already-snapshot
// view (jobs/links/attention are still read fresh from the DB each request).
const DEVICE_CACHE_TTL_MS = 10_000;
const LIST_TIMEOUT_MS = 8_000;
type DeviceCacheEntry = { at: number; devices: RemoteDevice[] };
const deviceCache = new Map<string, DeviceCacheEntry>();

export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new Error(label)), ms);
  });
  return Promise.race([p.finally(() => clearTimeout(t)), timeout]);
}

/** Persist one connection's last-good device list (survives process restarts —
 *  the durable half of the stale-while-revalidate below). */
async function putDeviceCacheRow(db: Kysely<DigifabDB>, connId: string, devices: RemoteDevice[], at: number): Promise<void> {
  try {
    await db
      .insertInto("digifab_fleet_device_cache")
      .values({ connection_id: connId, devices: JSON.stringify(devices) as never, fetched_at: new Date(at) })
      .onConflict((oc) => oc.column("connection_id").doUpdateSet({ devices: JSON.stringify(devices) as never, fetched_at: new Date(at) }))
      .execute();
  } catch (err) {
    console.warn(`[digifab] fleet device-cache write failed for ${connId}:`, (err as Error).message);
  }
}

// One in-flight background refresh per connection — a burst of stale-serves
// must not stack N live fetches onto one slow manager.
const refreshing = new Set<string>();

// The live list that last failed, per connection, until one succeeds. The cache
// served meanwhile is the last thing the manager said, not what it says now: a
// printer whose manager stopped answering must not read RUNNING at 24° (#7902).
const lastFailure = new Map<string, { at: number; error: string }>();

/** What a connection's devices are, and when we last heard them. `unreachable`
 *  names why the manager is not answering now: the devices are its last word. */
export type CachedDevices = { devices: RemoteDevice[]; at: number; stale: boolean; unreachable: string | null };

/** Cached + timeout-bounded device fetch for one connection, served
 *  STALE-WHILE-REVALIDATE so the fleet answers instantly:
 *    fresh memory hit (≤10s) → serve it.
 *    anything older — the memory entry, or the DURABLE per-connection row
 *    (survives restarts) → serve it IMMEDIATELY (marked stale) and kick ONE
 *    detached live refresh; the next poll gets fresh state.
 *    nothing cached at all (first ever look) → block on the live fetch.
 *  Live-fetch error → last-good cache if any, else rethrow so the caller
 *  renders the connection's error card. */
export async function fetchDevicesCached(
  db: Kysely<DigifabDB>,
  driver: MachineDriver,
  connId: string,
  finishedAt = 0,
): Promise<CachedDevices> {
  const now = Date.now();
  const hit = deviceCache.get(connId);
  if (hit && hit.at > finishedAt && now - hit.at < DEVICE_CACHE_TTL_MS) return { devices: hit.devices, at: hit.at, stale: false, unreachable: null };
  // A failure after the list we hold means that list is out of date.
  const failedSince = (at: number) => {
    const f = lastFailure.get(connId);
    return f && f.at >= at ? f.error : null;
  };

  const liveFetch = async (): Promise<{ devices: RemoteDevice[]; at: number }> => {
    const at = Date.now();
    let devices: RemoteDevice[];
    try {
      devices = await withTimeout(driver.listDevices(), LIST_TIMEOUT_MS, "listDevices timed out");
    } catch (err) {
      lastFailure.set(connId, { at: Date.now(), error: (err as Error).message?.slice(0, 160) || "unreachable" });
      throw err;
    }
    lastFailure.delete(connId);
    const entry = { at, devices };
    if (!deviceCache.has(connId) || deviceCache.get(connId)!.at <= at) deviceCache.set(connId, entry);
    void putDeviceCacheRow(db, connId, devices, at);
    return entry;
  };

  // A stale memory entry, or the durable row from before a restart → serve it
  // now, refresh detached.
  let stale = hit ?? null;
  if (!stale) {
    try {
      const row = await db
        .selectFrom("digifab_fleet_device_cache")
        .select(["devices", "fetched_at"])
        .where("connection_id", "=", connId)
        .executeTakeFirst();
      if (row) {
        const devices = (typeof row.devices === "string" ? JSON.parse(row.devices) : row.devices) as RemoteDevice[];
        if (Array.isArray(devices)) stale = { at: new Date(row.fetched_at).getTime(), devices };
      }
    } catch {
      /* unreadable row → treat as no cache */
    }
  }
  if (stale && stale.at > finishedAt) {
    if (!refreshing.has(connId)) {
      refreshing.add(connId);
      void liveFetch()
        .catch(() => {})
        .finally(() => refreshing.delete(connId));
    }
    // Seed memory for the stale-on-error window — but never clobber an entry a
    // just-finished background refresh may have written.
    if (!deviceCache.has(connId)) deviceCache.set(connId, stale);
    return { devices: stale.devices, at: stale.at, stale: true, unreachable: failedSince(stale.at) };
  }

  // First ever look at this connection — nothing to serve, wait for live.
  try {
    return { ...(await liveFetch()), stale: false, unreachable: null };
  } catch (err) {
    const fallback = deviceCache.get(connId);
    if (fallback && fallback.at > finishedAt) return { devices: fallback.devices, at: fallback.at, stale: true, unreachable: failedSince(fallback.at) };
    throw err;
  }
}

