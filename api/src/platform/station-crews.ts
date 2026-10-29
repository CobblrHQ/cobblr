// Who's working at a station (#8845).
//
// A tablet on a bench that four people share acted as the owner or admin who
// approved it, so a shift's every take, return and move read as one person's.
// An owner or admin now names the members who work at a station. The tablet
// then asks "Who's working?", and picking a member mints a token in that
// member's own name, scoped to the same station as the tablet's. Their role is
// what every route checks, exactly as on their own phone, and the activity
// log names them, "via Bench station". The tablet's own token may still read,
// but writes nothing while the station has a crew: nobody can skip the pick.
//
// A station may also ask each member for their own four-digit PIN, which they
// set in their own settings. Only its hash is kept.

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { sql } from "kysely";
import { meta } from "../db/meta.js";
import { mintTokenString } from "../auth/api-tokens.js";
import { ttlCache } from "../lib/ttl-cache.js";
import {
  STATION_CREW_IDLE_DEFAULT,
  STATION_CREW_IDLE_MAX,
  STATION_CREW_IDLE_MIN,
  STATION_CREW_TOKEN_TTL_MS,
  STATION_MEMBER_PIN_RE,
  STATION_TOKEN_ACCESS,
  isStationAddress,
  stationCrewScope,
  stationDeviceName,
  stationLabelOf,
  stationScope,
  type StationCrew,
  type StationCrewPick,
} from "@cobblr/platform-contract/station-screen";

/** The source a picked member's station token carries. */
export const STATION_CREW_TOKEN_SOURCE = "station crew";

function hashPin(pin: string): string {
  const salt = randomBytes(12).toString("base64url");
  return `${salt}:${scryptSync(pin, salt, 32).toString("base64url")}`;
}

function pinMatches(stored: string | null | undefined, pin: unknown): boolean {
  if (!stored || typeof pin !== "string") return false;
  const [salt, want] = stored.split(":");
  if (!salt || !want) return false;
  const got = scryptSync(pin, salt, 32);
  const exp = Buffer.from(want, "base64url"); // b64-lenient-ok: the hash this server stored, never a value from the request
  return got.length === exp.length && timingSafeEqual(got, exp);
}

// SINGLE-PROCESS-SAFE: a soft brake on guessing one member's PIN; a second api process only lets it guess a little more.
const pinTries = new Map<string, number[]>();
function pinThrottled(key: string): boolean {
  const now = Date.now();
  const recent = (pinTries.get(key) ?? []).filter((t) => now - t < 60_000);
  pinTries.set(key, recent);
  if (pinTries.size > 5_000) pinTries.delete(pinTries.keys().next().value as string);
  return recent.length >= 5;
}

/** Who may work at the station, as its settings and its screen show it.
 *  Only active members still in the workspace are listed. */
export async function stationCrew(orgId: string, address: string): Promise<StationCrew> {
  const row = await meta.selectFrom("station_crews").selectAll().where("org_id", "=", orgId).where("address", "=", address).executeTakeFirst();
  const ids = row?.user_ids ?? [];
  const people = ids.length
    ? await meta
        .selectFrom("org_memberships as m")
        .innerJoin("users as u", "u.id", "m.user_id")
        .leftJoin("station_member_pins as p", (j) => j.onRef("p.org_id", "=", "m.org_id").onRef("p.user_id", "=", "m.user_id"))
        .select(["u.id", "u.display_name", "u.email", "p.pin_hash"])
        .where("m.org_id", "=", orgId)
        .where("u.active", "=", true)
        .where("u.id", "in", ids)
        .execute()
    : [];
  const byId = new Map(people.map((p) => [p.id, p]));
  return {
    address,
    members: ids.flatMap((id) => {
      const p = byId.get(id);
      return p ? [{ user_id: p.id, name: p.display_name || p.email.split("@")[0]!, has_pin: !!p.pin_hash }] : [];
    }),
    pin_required: row?.pin_required ?? false,
    idle_minutes: row?.idle_minutes ?? STATION_CREW_IDLE_DEFAULT,
  };
}

export type SetCrewResult = { ok: true; crew: StationCrew } | { ok: false; code: "not_members" | "bad_idle" | "bad_address"; message: string };

/** Name who works at a station. A member taken off it stops acting there at
 *  once: their station tokens are revoked. */
export async function setStationCrew(p: { orgId: string; address: string; userIds: readonly string[]; pinRequired: boolean; idleMinutes: number; by: string }): Promise<SetCrewResult> {
  if (!isStationAddress(p.address)) return { ok: false, code: "bad_address", message: "That is not a station address." };
  if (!Number.isInteger(p.idleMinutes) || p.idleMinutes < STATION_CREW_IDLE_MIN || p.idleMinutes > STATION_CREW_IDLE_MAX) {
    return { ok: false, code: "bad_idle", message: `Clear who's working after 1 to ${STATION_CREW_IDLE_MAX} minutes.` };
  }
  const ids = [...new Set(p.userIds)];
  if (ids.length) {
    const found = await meta.selectFrom("org_memberships").select("user_id").where("org_id", "=", p.orgId).where("user_id", "in", ids).execute();
    if (found.length !== ids.length) return { ok: false, code: "not_members", message: "Everyone who works at a station has to be a member of this workspace." };
  }
  await meta
    .insertInto("station_crews")
    .values({ org_id: p.orgId, address: p.address, user_ids: ids, pin_required: p.pinRequired, idle_minutes: p.idleMinutes, updated_by: p.by })
    .onConflict((oc) => oc.columns(["org_id", "address"]).doUpdateSet({ user_ids: ids, pin_required: p.pinRequired, idle_minutes: p.idleMinutes, updated_by: p.by, updated_at: new Date() }))
    .execute();
  let gone = meta
    .updateTable("api_tokens")
    .set({ revoked_at: new Date() })
    .where("org_id", "=", p.orgId)
    .where("source", "=", STATION_CREW_TOKEN_SOURCE)
    .where("revoked_at", "is", null)
    .where(sql<boolean>`${stationCrewScope(p.address)} = any(scopes)`);
  if (ids.length) gone = gone.where("user_id", "not in", ids);
  await gone.execute();
  crewCache.delete(`${p.orgId}:${p.address}`);
  return { ok: true, crew: await stationCrew(p.orgId, p.address) };
}

export type PickResult = { ok: true; pick: StationCrewPick } | { ok: false; status: number; code: string; message: string };

/** The tablet's pick: a member of this station's crew, with their PIN when
 *  the station asks for one. The token is theirs and reaches only this
 *  station, as the tablet's does. */
export async function pickStationMember(p: { orgId: string; address: string; deviceTokenId: string | null; userId: unknown; pin: unknown }): Promise<PickResult> {
  const crew = await stationCrew(p.orgId, p.address);
  const member = crew.members.find((m) => m.user_id === p.userId);
  if (!member) return { ok: false, status: 403, code: "not_on_station", message: "That person doesn't work at this station. An owner or admin can add them in its settings." };
  if (crew.pin_required) {
    const key = `${p.orgId}:${member.user_id}`;
    if (pinThrottled(key)) return { ok: false, status: 429, code: "pin_wait", message: "Too many tries. Wait a minute." };
    const row = await meta.selectFrom("station_member_pins").select("pin_hash").where("org_id", "=", p.orgId).where("user_id", "=", member.user_id).executeTakeFirst();
    if (!row) return { ok: false, status: 403, code: "pin_unset", message: `${member.name} hasn't set a station PIN yet. They can set one in their own settings.` };
    if (!pinMatches(row.pin_hash, p.pin)) {
      pinTries.get(key)!.push(Date.now());
      return { ok: false, status: 403, code: "pin_wrong", message: "That PIN isn't right." };
    }
  }
  const device = p.deviceTokenId
    ? await meta.selectFrom("api_tokens").select(["meta"]).where("id", "=", p.deviceTokenId).executeTakeFirst()
    : undefined;
  const label = typeof (device?.meta as { label?: unknown } | null)?.label === "string" ? ((device!.meta as { label: string }).label) : stationLabelOf(p.address);
  const expires = new Date(Date.now() + STATION_CREW_TOKEN_TTL_MS);
  const { plaintext, hash, tokenPrefix } = mintTokenString();
  // check-then-insert: the read is the tablet's own token for its label; each new token has a fresh random hash.
  await meta
    .insertInto("api_tokens")
    .values({
      user_id: member.user_id,
      name: stationDeviceName(label),
      token_hash: hash,
      token_prefix: tokenPrefix,
      expires_at: expires,
      scopes: [stationScope(p.address), stationCrewScope(p.address)],
      source: STATION_CREW_TOKEN_SOURCE,
      meta: { kind: "station-crew", address: p.address, label, device_token_id: p.deviceTokenId },
      org_id: p.orgId,
      access: STATION_TOKEN_ACCESS,
    })
    .execute();
  return { ok: true, pick: { token: plaintext, user_id: member.user_id, name: member.name, expires_at: expires.toISOString() } };
}

/** The screen went back to Who's working?: the member's token ends. */
export async function endStationPick(orgId: string, tokenId: string): Promise<void> {
  await meta
    .updateTable("api_tokens")
    .set({ revoked_at: new Date() })
    .where("id", "=", tokenId)
    .where("org_id", "=", orgId)
    .where("source", "=", STATION_CREW_TOKEN_SOURCE)
    .where("revoked_at", "is", null)
    .execute();
}

export type PinResult = { ok: true; has_pin: boolean } | { ok: false; message: string };

/** A member sets or clears their own station PIN in a workspace. */
export async function setStationMemberPin(orgId: string, userId: string, pin: unknown): Promise<PinResult> {
  if (pin === null) {
    await meta.deleteFrom("station_member_pins").where("org_id", "=", orgId).where("user_id", "=", userId).execute();
    return { ok: true, has_pin: false };
  }
  if (typeof pin !== "string" || !STATION_MEMBER_PIN_RE.test(pin)) return { ok: false, message: "A station PIN is four digits." };
  const pin_hash = hashPin(pin);
  await meta
    .insertInto("station_member_pins")
    .values({ org_id: orgId, user_id: userId, pin_hash })
    .onConflict((oc) => oc.columns(["org_id", "user_id"]).doUpdateSet({ pin_hash, updated_at: new Date() }))
    .execute();
  return { ok: true, has_pin: true };
}

export async function stationMemberHasPin(orgId: string, userId: string): Promise<boolean> {
  return !!(await meta.selectFrom("station_member_pins").select("user_id").where("org_id", "=", orgId).where("user_id", "=", userId).executeTakeFirst());
}

// The tablet's own token writes nothing while its station has a crew. Read
// on every write a station's token makes, so it is kept a few seconds.
// SINGLE-PROCESS-SAFE: a stale answer lasts five seconds; setStationCrew clears this process's copy at once.
const crewCache = ttlCache<boolean>(5_000);

export function stationHasCrew(orgId: string, address: string): Promise<boolean> {
  return crewCache.get(`${orgId}:${address}`, async () => {
    const row = await meta.selectFrom("station_crews").select("user_ids").where("org_id", "=", orgId).where("address", "=", address).executeTakeFirst();
    return (row?.user_ids?.length ?? 0) > 0;
  });
}
