import type { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { InventoryDB } from "./db.js";

export async function withRecountLock<T>(orgId: string, id: string, run: (db: Kysely<InventoryDB>) => Promise<T>): Promise<T> {
  return platform().exclusive.serial(`inventory:recount:${orgId}:${id}`, async () => {
    const db = await platform().tenants.getDb(orgId) as Kysely<InventoryDB>;
    return run(db);
  });
}
