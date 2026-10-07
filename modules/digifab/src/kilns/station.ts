import type { Kysely } from "kysely";
import type { DigifabDB } from "../db.js";
import { stationTokenHash } from "../laser-station.js";
import { KilnRefusal } from "./store.js";
const permits = new WeakSet<object>();
export interface KilnPermit { readonly connectionId: string; readonly deviceId: string }
export function hasKilnPermit(permit: KilnPermit): boolean { return permits.has(permit); }
export async function authorizeKiln(db: Kysely<DigifabDB>, connectionId: string, deviceId: string, token: string): Promise<KilnPermit> {
 const station = await db.selectFrom("digifab_stations").select("id").where("connection_id", "=", connectionId).where("remote_device_id", "=", deviceId).where("token_hash", "=", stationTokenHash(token)).where("revoked_at", "is", null).executeTakeFirst();
 if (!station) throw new KilnRefusal("Authorize this screen for this kiln before Start or Stop.");
 const permit = Object.freeze({ connectionId, deviceId }); permits.add(permit); return permit;
}
