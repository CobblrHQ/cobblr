// Latest webcam frame per device for the snapshot relay. Stored in the TENANT DB
// (one row per device, overwritten on each push) so it works across multiple API
// instances — not just one process's memory. Only written while the relay is ON
// for that device (opt-in), so no churn unless enabled. Read with a freshness
// window; a stale frame reads as absent. See architecture/edge-reach.md.

import type { Kysely } from "kysely";
import type { DigifabDB } from "./db.js";

const TTL_MS = 30_000;
const MAX_BYTES = 4 * 1024 * 1024;

/** Store a JPEG frame for (connection, device). Rejects non-JPEG / oversized. */
export async function putSnapshot(db: Kysely<DigifabDB>, connId: string, devId: string, jpeg: Buffer): Promise<boolean> {
  if (jpeg.length === 0 || jpeg.length > MAX_BYTES) return false;
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return false; // JPEG start-of-image
  await db
    .insertInto("digifab_device_snapshots")
    .values({ connection_id: connId, remote_device_id: devId, jpeg, updated_at: new Date() })
    .onConflict((oc) => oc.columns(["connection_id", "remote_device_id"]).doUpdateSet({ jpeg, updated_at: new Date() }))
    .execute();
  return true;
}

/** The latest fresh frame for one device, or null when absent/stale. */
export async function getSnapshot(db: Kysely<DigifabDB>, connId: string, devId: string): Promise<Buffer | null> {
  const row = await db
    .selectFrom("digifab_device_snapshots")
    .select(["jpeg", "updated_at"])
    .where("connection_id", "=", connId)
    .where("remote_device_id", "=", devId)
    .executeTakeFirst();
  if (!row) return null;
  if (Date.now() - new Date(row.updated_at).getTime() > TTL_MS) return null;
  return row.jpeg;
}

/** `${connId}:${devId}` keys with a fresh frame — one query for the fleet's
 *  per-device freshness check (avoids N queries + fetching the bytes). */
export async function freshSnapshotKeys(db: Kysely<DigifabDB>): Promise<Set<string>> {
  const rows = await db
    .selectFrom("digifab_device_snapshots")
    .select(["connection_id", "remote_device_id"])
    .where("updated_at", ">", new Date(Date.now() - TTL_MS))
    .execute();
  return new Set(rows.map((r) => `${r.connection_id}:${r.remote_device_id}`));
}
