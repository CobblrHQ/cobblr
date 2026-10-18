import type { Kysely } from "kysely";
import type { DigifabDB } from "../../db.js";
import { stationTokenHash } from "../../laser-station.js";
import { KilnRefusal } from "./store.js";
import type { CommandResult } from "../../drivers/types.js";
import type { EdgeAdapterDriver } from "../../drivers/edge-adapter.js";
const permits = new WeakSet<object>();
export interface KilnPermit { readonly connectionId: string; readonly deviceId: string }
export function hasKilnPermit(permit: KilnPermit): boolean { return permits.has(permit); }
export async function authorizeKiln(db: Kysely<DigifabDB>, connectionId: string, deviceId: string, token: string): Promise<KilnPermit> {
 const station = await db.selectFrom("digifab_stations").select("id").where("connection_id", "=", connectionId).where("remote_device_id", "=", deviceId).where("token_hash", "=", stationTokenHash(token)).where("revoked_at", "is", null).executeTakeFirst();
 if (!station) throw new KilnRefusal("Authorize this screen for this kiln before Start or Stop.");
 const permit = Object.freeze({ connectionId, deviceId }); permits.add(permit); return permit;
}

/** Start or Stop a kiln at its station, through the bridge's command door
 *  (familyRequest). Start asks `checkStartAllowed` just before the kiln is
 *  told and again once it answers: a station revoked in between never starts
 *  it, and one revoked while it answered gets Stop. A Start with no check is
 *  refused; Stop is never held back. The bridge's generic command refuses
 *  kiln_start and kiln_stop, so this is the only way to them. */
export async function kilnAtStation(driver: Pick<EdgeAdapterDriver, "familyRequest">, permit: KilnPermit, operation: "start" | "stop", params: Record<string, unknown>, checkStartAllowed?: () => Promise<void>): Promise<CommandResult> {
 if (!hasKilnPermit(permit)) return { ok: false, detail: "Authorize at the kiln's station." };
 const send = (op: "start" | "stop") => driver.familyRequest("POST", "/command", { body: { command: `kiln_${op}`, params: { ...(op === "start" ? params : {}), device_id: permit.deviceId } } }) as Promise<CommandResult>;
 if (operation === "stop") return await send("stop");
 if (!checkStartAllowed) return { ok: false, detail: "Authorize at the kiln's station." };
 try { await checkStartAllowed(); } catch (e) { return { ok: false, detail: e instanceof Error ? e.message : "Start was withdrawn." }; }
 const result = await send("start");
 try {
  await checkStartAllowed();
 } catch {
  await send("stop").catch(() => {});
  return { ok: false, detail: "The station lost Start while the kiln answered, so Stop was sent. Check the kiln before starting it again." };
 }
 return result;
}
