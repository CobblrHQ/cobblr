import type { Kysely } from "kysely";
import type { DigifabDB } from "../../db.js";
import { stationTokenHash } from "../../laser-station.js";
export class ArmRefusal extends Error {}
const permits = new WeakSet<object>();
export interface ArmPermit { readonly connectionId: string; readonly deviceId: string }
export function hasArmPermit(permit: ArmPermit | null | undefined, deviceId: string): boolean { return !!permit && permits.has(permit) && permit.deviceId === deviceId; }
/** A screen authorized beside this arm. Load, start, resume and power need
 *  one; pause and stop never wait for it. */
export async function authorizeArm(db: Kysely<DigifabDB>, connectionId: string, deviceId: string, token: unknown): Promise<ArmPermit> {
 if (typeof token !== "string" || token.length < 32) throw new ArmRefusal("Authorize this screen at the arm's station first.");
 const station = await db.selectFrom("digifab_stations").select("id").where("connection_id", "=", connectionId).where("remote_device_id", "=", deviceId).where("token_hash", "=", stationTokenHash(token)).where("revoked_at", "is", null).executeTakeFirst();
 if (!station) throw new ArmRefusal("This screen is not authorized for this arm.");
 const permit = Object.freeze({ connectionId, deviceId }); permits.add(permit); return permit;
}
