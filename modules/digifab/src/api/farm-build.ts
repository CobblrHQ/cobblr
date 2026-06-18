// Shared "build a farm" primitives — used by BOTH the FDM Monster import
// (import.ts) and the bulk add-printers wizard (bulk.ts). Same three moves:
// make sure the declarative drivers we need are installed, open a pool, and
// add members to it. Kept in one place so the two entry points can't drift.

import { sql, type Kysely } from "kysely";
import type { DigifabDB } from "../db.js";
import { DRIVER_CATALOG } from "../drivers/catalog.js";

/** Install any catalog (declarative) drivers we'll need but don't have yet.
 *  No-op for types not in the catalog (built-ins like fdm_monster/mock, or a
 *  type the user pasted that we don't ship — the create call rejects those). */
export async function ensureDeclarativeDrivers(db: Kysely<DigifabDB>, types: Iterable<string>): Promise<void> {
  for (const dtype of new Set(types)) {
    const cat = DRIVER_CATALOG.find((e) => e.id === dtype);
    if (!cat) continue;
    await db
      .insertInto("digifab_drivers")
      .values({ key: cat.manifest.id, name: cat.manifest.name, kind: "declarative", spec: sql`${JSON.stringify(cat.manifest)}::jsonb` as never })
      .onConflict((oc) => oc.column("key").doNothing())
      .execute();
  }
}

/** Create a pool, return its id. */
export async function createPool(db: Kysely<DigifabDB>, name: string): Promise<string> {
  const pool = await db.insertInto("digifab_pools").values({ name }).returning(["id"]).executeTakeFirstOrThrow();
  return pool.id;
}

/** Add one (connection, remote device) to a pool; idempotent. */
export async function addPoolMember(db: Kysely<DigifabDB>, poolId: string, connectionId: string, remoteDeviceId: string): Promise<void> {
  await db
    .insertInto("digifab_pool_members")
    .values({ pool_id: poolId, connection_id: connectionId, remote_device_id: remoteDeviceId })
    .onConflict((oc) => oc.columns(["pool_id", "connection_id", "remote_device_id"]).doNothing())
    .execute();
}
